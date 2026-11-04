/**
 * DetMath.ts
 *
 * Math for anything that affects gameplay. Math.sin and friends can differ in the last digit between JavaScript
 * engines (Chrome's and Node's do), which would make an honest run fail its server replay. These use only
 * + - * / and sqrt, which IEEE 754 defines exactly, so every engine gets the same bits.
 * Rendering may keep using Math.*. The replay verifier throws on engine-dependent Math calls in gameplay.
 */

const TWO_OVER_PI = 6.36619772367581382433e-1;
const PIO2_HIGH = 1.57079632673412561417;
const PIO2_LOW = 6.07710050650619224932e-11;

// Polynomial coefficients from fdlibm's k_sin.c and k_cos.c
function kernelSin(r: number): number {
  const z = r * r;
  return r + r * z * (-1.66666666666666324348e-1 + z * (8.33333333332248946124e-3 + z * (-1.98412698298579493134e-4 +
    z * (2.75573137070700676789e-6 + z * (-2.50507602534068634195e-8 + z * 1.58969099521155010221e-10)))));
}

function kernelCos(r: number): number {
  const z = r * r;
  return 1 - 0.5 * z + z * z * (4.16666666666666019037e-2 + z * (-1.38888888888741095749e-3 + z * (2.48015872894767294178e-5 +
    z * (-2.75573143513906633035e-7 + z * (2.08757232129817482790e-9 + z * -1.13596475577881948265e-11)))));
}

export function detSin(x: number): number {
  const k = Math.round(x * TWO_OVER_PI);
  const r = x - k * PIO2_HIGH - k * PIO2_LOW;
  const quadrant = ((k % 4) + 4) % 4;
  if (quadrant === 0) return kernelSin(r);
  if (quadrant === 1) return kernelCos(r);
  if (quadrant === 2) return -kernelSin(r);
  return -kernelCos(r);
}

export function detCos(x: number): number {
  const k = Math.round(x * TWO_OVER_PI);
  const r = x - k * PIO2_HIGH - k * PIO2_LOW;
  const quadrant = ((k % 4) + 4) % 4;
  if (quadrant === 0) return kernelCos(r);
  if (quadrant === 1) return -kernelSin(r);
  if (quadrant === 2) return -kernelCos(r);
  return kernelSin(r);
}

export function detTan(x: number): number {
  return detSin(x) / detCos(x);
}

export function detHypot(a: number, b: number): number {
  return Math.sqrt(a * a + b * b);
}
