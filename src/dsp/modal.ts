import type { ModeSpec } from "../model.js";

class DampedMode {
  private readonly a1: number;
  private readonly a2: number;
  private readonly inputGain: number;
  private readonly gainLeft: number;
  private readonly gainRight: number;
  private y1 = 0;
  private y2 = 0;
  outputLeft = 0;
  outputRight = 0;

  constructor(spec: ModeSpec, sampleRate: number) {
    const radius = Math.exp(-Math.log(1000) / (spec.t60Seconds * sampleRate));
    const theta = (2 * Math.PI * spec.frequencyHz) / sampleRate;
    this.a1 = 2 * radius * Math.cos(theta);
    this.a2 = -(radius * radius);
    // Normalize |H(e^j theta)| to one. This keeps T60 responsible for decay
    // duration without accidentally making lightly damped modes much louder.
    this.inputGain = (1 - radius) * Math.sqrt(
      1 + radius * radius - 2 * radius * Math.cos(2 * theta)
    );
    const angle = (spec.pan + 1) * Math.PI * 0.25;
    this.gainLeft = spec.gain * Math.cos(angle);
    this.gainRight = spec.gain * Math.sin(angle);
  }

  process(excitation: number): void {
    const y = this.inputGain * excitation + this.a1 * this.y1 + this.a2 * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    this.outputLeft = y * this.gainLeft;
    this.outputRight = y * this.gainRight;
  }
}

export class ModalBank {
  private readonly modes: readonly DampedMode[];
  outputLeft = 0;
  outputRight = 0;

  constructor(specs: readonly ModeSpec[], sampleRate: number) {
    this.modes = specs.map((spec) => new DampedMode(spec, sampleRate));
  }

  process(excitation: number): this {
    let left = 0;
    let right = 0;
    for (const mode of this.modes) {
      mode.process(excitation);
      left += mode.outputLeft;
      right += mode.outputRight;
    }
    this.outputLeft = left;
    this.outputRight = right;
    return this;
  }
}
