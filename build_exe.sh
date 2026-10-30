#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"

NODE_BIN="/home/kilgore/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="/home/kilgore/.cache/dwarf-kii-node/bin/node"
fi

"$NODE_BIN" build.mjs
python3 build_offline.py

# GCC emits the Microsoft x64 calling convention; GNU ld links a native PE executable.
gcc -c launcher.c -o build/launcher.elf.o -Os -mabi=ms -fshort-wchar -ffreestanding -fno-builtin -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fpie -mno-red-zone -Wall -Wextra
objcopy --remove-section .comment --remove-section .note.GNU-stack --remove-section .note.gnu.property build/launcher.elf.o
cat > build/payload.s <<'ASM'
.section .rdata,"a"
.global payload_start
.global payload_end
payload_start:
.incbin "build/payload.bin"
payload_end:
ASM
as --64 build/payload.s -o build/payload.elf.o
ld -mi386pep --subsystem windows --entry entry --dynamicbase --nxcompat --high-entropy-va --no-insert-timestamp -o 'Alpha Miner.exe' build/launcher.elf.o build/payload.elf.o -L/usr/x86_64-w64-mingw32/sys-root/mingw/lib -lkernel32 -luser32 -lshell32 -lshlwapi -lole32 -ladvapi32
file 'Alpha Miner.exe'
sha256sum 'Alpha Miner.exe' > SHA256SUMS.txt
cat SHA256SUMS.txt
