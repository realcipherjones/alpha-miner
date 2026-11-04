"""KII ledger primitives: accounts, state blocks, signing, proof of work and node RPC. Standard library only.

KII is a Nano fork: Ed25519 with blake2b-512, and 1 KII = 10^17 raw. The crypto matches ~/kii/ceremony/sign.py,
and test_server.py checks it against known vectors.
"""
import hashlib
import json
import multiprocessing
import os
import urllib.request

KII = 10**17
ALPHABET = "13456789abcdefghijkmnopqrstuwxyz"
SEND_DIFFICULTY = 0xfffffe0000000000  # 2^23 expected hashes, the node's send threshold
PREAMBLE = (6).to_bytes(32, "big")

_q = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493
_d = -121665 * pow(121666, _q - 2, _q) % _q
_I = pow(2, (_q - 1) // 4, _q)


def _H(m):
    return hashlib.blake2b(m, digest_size=64).digest()


def _xrecover(y):
    xx = (y * y - 1) * pow(_d * y * y + 1, _q - 2, _q)
    x = pow(xx, (_q + 3) // 8, _q)
    if (x * x - xx) % _q:
        x = x * _I % _q
    return _q - x if x % 2 else x


_By = 4 * pow(5, _q - 2, _q) % _q
_B = (_xrecover(_By), _By)


def _add(P, Q):
    (x1, y1), (x2, y2) = P, Q
    t = _d * x1 * x2 * y1 * y2
    return ((x1 * y2 + x2 * y1) * pow(1 + t, _q - 2, _q) % _q, (y1 * y2 + x1 * x2) * pow(1 - t, _q - 2, _q) % _q)


def _mul(P, e):
    R = (0, 1)
    while e:
        if e & 1:
            R = _add(R, P)
        P = _add(P, P)
        e >>= 1
    return R


def _scalar(h):
    return 2**254 + sum(2**i * ((h[i // 8] >> (i % 8)) & 1) for i in range(3, 254))


def public_key(private):
    x, y = _mul(_B, _scalar(_H(private)))
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def private_from_seed(seed, index=0):
    """Standard Nano wallet derivation, as Nault uses."""
    return hashlib.blake2b(seed + index.to_bytes(4, "big"), digest_size=32).digest()


def ed_sign(msg, private):
    h = _H(private)
    a = _scalar(h)
    pk = public_key(private)
    r = int.from_bytes(_H(h[32:] + msg), "little")
    x, y = _mul(_B, r)
    R = (y | ((x & 1) << 255)).to_bytes(32, "little")
    S = (r + int.from_bytes(_H(R + pk + msg), "little") * a) % _L
    return R + S.to_bytes(32, "little")


def ed_verify(sig, msg, pub):
    def dec(b):
        y = int.from_bytes(b, "little") & (2**255 - 1)
        x = _xrecover(y)
        return (_q - x if (x & 1) != (b[31] >> 7) else x, y)
    if len(sig) != 64 or int.from_bytes(sig[32:], "little") >= _L:
        return False
    h = int.from_bytes(_H(sig[:32] + pub + msg), "little")
    return _mul(_B, int.from_bytes(sig[32:], "little")) == _add(dec(sig[:32]), _mul(dec(pub), h))


def account_from_public(pub):
    check = hashlib.blake2b(pub, digest_size=5).digest()[::-1]
    n = int.from_bytes(b"\0\0\0" + pub + check, "big")
    return "kii_" + "".join(ALPHABET[(n >> (5 * i)) & 31] for i in reversed(range(60)))


def decode_account(address):
    """Public key bytes of a kii_ address, or ValueError if the address or its checksum is bad."""
    if not (isinstance(address, str) and len(address) == 64 and address.startswith("kii_")):
        raise ValueError("not a kii_ address")
    n = 0
    for c in address[4:]:
        if c not in ALPHABET:
            raise ValueError("bad character in address")
        n = n * 32 + ALPHABET.index(c)
    if n >> 296:
        raise ValueError("bad address")
    pub = n.to_bytes(38, "big")[-37:-5]
    if account_from_public(pub) != address:
        raise ValueError("bad address checksum")
    return pub


def state_hash(account, previous, representative, balance, link):
    return hashlib.blake2b(PREAMBLE + account + previous + representative + balance.to_bytes(16, "big") + link, digest_size=32).digest()


def build_send(private, frontier_hex, representative, balance_after, destination):
    """A signed state send, without proof of work (work isn't part of what is signed)."""
    pub = public_key(private)
    previous = bytes.fromhex(frontier_hex)
    digest = state_hash(pub, previous, decode_account(representative), balance_after, decode_account(destination))
    return digest.hex().upper(), {
        "type": "state",
        "account": account_from_public(pub),
        "previous": previous.hex().upper(),
        "representative": representative,
        "balance": str(balance_after),
        "link": decode_account(destination).hex().upper(),
        "link_as_account": destination,
        "signature": ed_sign(digest, private).hex().upper(),
    }


def work_value(work, root):
    digest = hashlib.blake2b(work.to_bytes(8, "little") + root, digest_size=8).digest()
    return int.from_bytes(digest, "little")


def _work_search(args):
    root, start, count, difficulty = args
    for work in range(start, start + count):
        if work_value(work & 0xffffffffffffffff, root) >= difficulty:
            return work & 0xffffffffffffffff
    return None


def generate_work(root_hex, difficulty=SEND_DIFFICULTY, processes=None):
    """CPU proof of work, so live nodes can keep control RPC (and with it work_generate) off."""
    root = bytes.fromhex(root_hex)
    start = int.from_bytes(os.urandom(8), "big")
    chunk = 1 << 18
    workers = processes or os.cpu_count() or 1
    with multiprocessing.get_context("fork").Pool(workers) as pool:
        while True:
            jobs = [(root, start + i * chunk, chunk, difficulty) for i in range(workers * 4)]
            start += len(jobs) * chunk
            for found in pool.imap_unordered(_work_search, jobs):
                if found is not None:
                    pool.terminate()
                    return f"{found:016x}"


class NodeRpc:
    """Loopback RPC to the KII node. Errors raise, so a failed call can never look like success."""

    def __init__(self, url):
        self.url = url

    def call(self, action, allow_error=False, **fields):
        request = urllib.request.Request(self.url, json.dumps({"action": action, **fields}).encode())
        with urllib.request.urlopen(request, timeout=30) as response:
            reply = json.load(response)
        if "error" in reply and not allow_error:
            raise RuntimeError(f"node {action}: {reply['error']}")
        return reply
