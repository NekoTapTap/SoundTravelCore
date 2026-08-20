export class Xoshiro128 {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    let x = seed >>> 0;
    const nextSeed = (): number => {
      x = (x + 0x9e37_79b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0_aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a_2d97);
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.a = nextSeed();
    this.b = nextSeed();
    this.c = nextSeed();
    this.d = nextSeed();
  }

  nextUint32(): number {
    const result = Math.imul(((this.a + this.d) >>> 0), 9);
    const t = (this.b << 9) >>> 0;
    this.c ^= this.a;
    this.d ^= this.b;
    this.b ^= this.c;
    this.a ^= this.d;
    this.c ^= t;
    this.d = ((this.d << 11) | (this.d >>> 21)) >>> 0;
    return result >>> 0;
  }

  bipolar(): number {
    return this.nextUint32() / 0x8000_0000 - 1;
  }
}

