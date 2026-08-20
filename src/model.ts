export interface ModeSpec {
  readonly frequencyHz: number;
  readonly t60Seconds: number;
  readonly gain: number;
  readonly pan: number;
}

export interface TrainModelConfig {
  readonly sampleRate: number;
  readonly speedRatio: number;
  readonly roughness: number;
  readonly contactLevel: number;
  readonly structureLevel: number;
  readonly airLevel: number;
  readonly stereoWidth: number;
  readonly outputGain: number;
  readonly seed: number;
  readonly trackSupportModes: readonly ModeSpec[];
  readonly runningGearModes: readonly ModeSpec[];
}

/**
 * Frequencies and damping times are initialized from the reference analysis.
 * The gains and pan values are synthesis parameters, not measured identities.
 */
export const defaultConfig: TrainModelConfig = {
  sampleRate: 44_100,
  speedRatio: 1,
  roughness: 0.82,
  contactLevel: 0.72,
  structureLevel: 0.85,
  airLevel: 0.70,
  stereoWidth: 0.72,
  outputGain: 0.48,
  seed: 0x54a9_21d3,
  trackSupportModes: [
    { frequencyHz: 80.750, t60Seconds: 0.539, gain: 0.13, pan: -0.08 },
    { frequencyHz: 99.086, t60Seconds: 0.469, gain: 0.14, pan: 0.06 },
    { frequencyHz: 224.248, t60Seconds: 0.460, gain: 0.18, pan: 0.05 }
  ],
  runningGearModes: [
    { frequencyHz: 142.153, t60Seconds: 0.394, gain: 0.12, pan: -0.12 },
    { frequencyHz: 288.007, t60Seconds: 0.239, gain: 0.14, pan: -0.07 },
    { frequencyHz: 421.916, t60Seconds: 0.218, gain: 0.10, pan: 0.13 },
    { frequencyHz: 451.861, t60Seconds: 0.463, gain: 0.10, pan: -0.04 }
  ]
};
