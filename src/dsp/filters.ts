export class OnePoleLowpass {
  private readonly a: number;
  private z = 0;

  constructor(cutoffHz: number, sampleRate: number) {
    this.a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  }

  process(x: number): number {
    this.z += this.a * (x - this.z);
    return this.z;
  }
}

/** One-pole filtered uniform noise, normalized to approximately unit variance. */
export class NormalizedNoiseLowpass {
  private readonly a: number;
  private readonly normalization: number;
  private z = 0;

  constructor(cutoffHz: number, sampleRate: number) {
    this.a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
    this.normalization = Math.sqrt((3 * (2 - this.a)) / this.a);
  }

  process(whiteUniformBipolar: number): number {
    this.z += this.a * (whiteUniformBipolar - this.z);
    return this.z * this.normalization;
  }
}

/** Envelope of radiated energy with independent attack and release constants. */
export class AttackReleaseEnvelope {
  private readonly attack: number;
  private readonly release: number;
  private value = 0;

  constructor(attackSeconds: number, releaseSeconds: number, sampleRate: number) {
    this.attack = 1 - Math.exp(-1 / (attackSeconds * sampleRate));
    this.release = 1 - Math.exp(-1 / (releaseSeconds * sampleRate));
  }

  process(magnitude: number): number {
    const coefficient = magnitude > this.value ? this.attack : this.release;
    this.value += coefficient * (magnitude - this.value);
    return this.value;
  }
}

export class DcBlocker {
  private x1 = 0;
  private y1 = 0;

  process(x: number): number {
    const y = x - this.x1 + 0.995 * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

export class Biquad {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  static lowpass(frequencyHz: number, q: number, sampleRate: number): Biquad {
    return Biquad.design("lowpass", frequencyHz, q, sampleRate);
  }

  static highpass(frequencyHz: number, q: number, sampleRate: number): Biquad {
    return Biquad.design("highpass", frequencyHz, q, sampleRate);
  }

  static bandpass(frequencyHz: number, q: number, sampleRate: number): Biquad {
    return Biquad.design("bandpass", frequencyHz, q, sampleRate);
  }

  private static design(kind: "lowpass" | "highpass" | "bandpass", frequencyHz: number, q: number, sampleRate: number): Biquad {
    const filter = new Biquad();
    const omega = (2 * Math.PI * frequencyHz) / sampleRate;
    const sin = Math.sin(omega);
    const cos = Math.cos(omega);
    const alpha = sin / (2 * q);
    const a0 = 1 + alpha;

    if (kind === "lowpass") {
      filter.b0 = (1 - cos) * 0.5 / a0;
      filter.b1 = (1 - cos) / a0;
      filter.b2 = filter.b0;
    } else if (kind === "highpass") {
      filter.b0 = (1 + cos) * 0.5 / a0;
      filter.b1 = -(1 + cos) / a0;
      filter.b2 = filter.b0;
    } else {
      filter.b0 = alpha / a0;
      filter.b1 = 0;
      filter.b2 = -alpha / a0;
    }
    filter.a1 = (-2 * cos) / a0;
    filter.a2 = (1 - alpha) / a0;
    return filter;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}
