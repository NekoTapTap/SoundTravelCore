import type { TrainModelConfig } from "./model.js";
import { defaultConfig } from "./model.js";
import {
  AttackReleaseEnvelope,
  Biquad,
  DcBlocker,
  NormalizedNoiseLowpass,
  OnePoleLowpass
} from "./dsp/filters.js";
import { ModalBank } from "./dsp/modal.js";
import { Xoshiro128 } from "./dsp/random.js";
import { WheelRailContact } from "./dsp/track-contact.js";

export interface StereoBlock {
  readonly left: Float32Array;
  readonly right: Float32Array;
}

const boundedLinear = (sample: number): number => Math.max(
  -1,
  Math.min(1, sample)
);

/** A stateful generator: successive calls continue the same physical process. */
export class TrainAmbienceGenerator {
  readonly config: TrainModelConfig;
  private readonly random: Xoshiro128;
  private readonly wheelRailContact: WheelRailContact;
  private readonly bedModalBank: ModalBank;
  private readonly contactModalBank: ModalBank;
  private readonly roughLeftBands: readonly { filter: Biquad; gain: number }[];
  private readonly roughRightBands: readonly { filter: Biquad; gain: number }[];
  private readonly roughLeftHighpass: Biquad;
  private readonly roughRightHighpass: Biquad;
  private readonly contactPatchLeft: Biquad;
  private readonly contactPatchRight: Biquad;
  private readonly contactPatchLeftMid: Biquad;
  private readonly contactPatchLeftUpper: Biquad;
  private readonly contactPatchLeftHigh: Biquad;
  private readonly contactPatchRightMid: Biquad;
  private readonly contactPatchRightUpper: Biquad;
  private readonly contactPatchRightHigh: Biquad;
  private readonly airLeftHighpass: Biquad;
  private readonly airRightHighpass: Biquad;
  private readonly airLeftLowpass: Biquad;
  private readonly airRightLowpass: Biquad;
  private readonly sideLowpass: OnePoleLowpass;
  private readonly rollingSideHighpass: Biquad;
  private readonly bedRollingLeftLowpass: Biquad;
  private readonly bedRollingRightLowpass: Biquad;
  private readonly forceLowpass: Biquad;
  private readonly contactMidLeft: Biquad;
  private readonly contactMidRight: Biquad;
  private readonly contactMidLeftLowpassA: Biquad;
  private readonly contactMidLeftLowpassB: Biquad;
  private readonly contactMidRightLowpassA: Biquad;
  private readonly contactMidRightLowpassB: Biquad;
  private readonly contactHighLeft: Biquad;
  private readonly contactHighRight: Biquad;
  private readonly contactHighLeftLowpassA: Biquad;
  private readonly contactHighLeftLowpassB: Biquad;
  private readonly contactHighRightLowpassA: Biquad;
  private readonly contactHighRightLowpassB: Biquad;
  private readonly wheelFieldEnvelopeLeft: AttackReleaseEnvelope;
  private readonly wheelFieldEnvelopeRight: AttackReleaseEnvelope;
  private readonly balanceDrift: NormalizedNoiseLowpass;
  private readonly trackbedDrift: NormalizedNoiseLowpass;
  private auxiliaryElectricalPhase = 0.37;
  private auxiliaryShaftPhase = 0.11;
  private readonly dcLeft = new DcBlocker();
  private readonly dcRight = new DcBlocker();

  constructor(config: TrainModelConfig = defaultConfig) {
    this.config = config;
    this.random = new Xoshiro128(config.seed);
    this.wheelRailContact = new WheelRailContact(config.sampleRate, this.random);
    // Track support modes are driven by the rail-pad force, not by an
    // unrelated low-frequency noise source.  Their bands match the region in
    // which flexible sleepers and ballast are physically important.
    this.bedModalBank = new ModalBank(
      config.trackSupportModes,
      config.sampleRate
    );
    // Keep the low carbody modes short and quiet so the broadband wheel/rail
    // paths, rather than a dense comb of resonances, carry the events.
    this.contactModalBank = new ModalBank(
      config.runningGearModes.map((mode) => ({
        ...mode,
        t60Seconds: mode.t60Seconds * 0.45,
        gain: mode.gain * 0.34
      })),
      config.sampleRate
    );

    // Parallel filters approximate the measured rolling spectrum. Their centers
    // have spatial meaning: roughness wavelengths mapped to temporal frequency.
    this.roughLeftBands = [
      { filter: Biquad.bandpass(52, 0.72, config.sampleRate), gain: 0.008 },
      { filter: Biquad.bandpass(125, 1.20, config.sampleRate), gain: 5.70 },
      { filter: Biquad.bandpass(315, 1.00, config.sampleRate), gain: 2.40 },
      { filter: Biquad.bandpass(690, 1.80, config.sampleRate), gain: 0.29 },
      { filter: Biquad.bandpass(1500, 0.82, config.sampleRate), gain: 0.0025 },
      { filter: Biquad.bandpass(3300, 0.90, config.sampleRate), gain: 0.0028 },
      { filter: Biquad.bandpass(6500, 1.00, config.sampleRate), gain: 0.003 }
    ];
    this.roughRightBands = [
      { filter: Biquad.bandpass(54, 0.72, config.sampleRate), gain: 0.008 },
      { filter: Biquad.bandpass(128, 1.16, config.sampleRate), gain: 5.55 },
      { filter: Biquad.bandpass(320, 1.03, config.sampleRate), gain: 2.35 },
      { filter: Biquad.bandpass(720, 1.72, config.sampleRate), gain: 0.28 },
      { filter: Biquad.bandpass(1540, 0.84, config.sampleRate), gain: 0.0027 },
      { filter: Biquad.bandpass(3400, 0.88, config.sampleRate), gain: 0.0031 },
      { filter: Biquad.bandpass(6600, 1.04, config.sampleRate), gain: 0.003 }
    ];
    this.roughLeftHighpass = Biquad.highpass(75, 0.707, config.sampleRate);
    this.roughRightHighpass = Biquad.highpass(75, 0.707, config.sampleRate);
    this.contactPatchLeft = Biquad.lowpass(2500, 0.707, config.sampleRate);
    this.contactPatchRight = Biquad.lowpass(2500, 0.707, config.sampleRate);
    this.contactPatchLeftMid = Biquad.lowpass(2500, 0.707, config.sampleRate);
    this.contactPatchLeftUpper = Biquad.lowpass(2500, 0.707, config.sampleRate);
    this.contactPatchLeftHigh = Biquad.lowpass(2500, 0.707, config.sampleRate);
    this.contactPatchRightMid = Biquad.lowpass(2500, 0.707, config.sampleRate);
    this.contactPatchRightUpper = Biquad.lowpass(2500, 0.707, config.sampleRate);
    this.contactPatchRightHigh = Biquad.lowpass(2500, 0.707, config.sampleRate);
    this.airLeftHighpass = Biquad.highpass(2200, 0.707, config.sampleRate);
    this.airRightHighpass = Biquad.highpass(2200, 0.707, config.sampleRate);
    this.airLeftLowpass = Biquad.lowpass(6000, 0.707, config.sampleRate);
    this.airRightLowpass = Biquad.lowpass(6000, 0.707, config.sampleRate);
    this.sideLowpass = new OnePoleLowpass(1100, config.sampleRate);
    this.rollingSideHighpass = Biquad.highpass(630, 0.707, config.sampleRate);
    this.bedRollingLeftLowpass = Biquad.lowpass(1400, 0.707, config.sampleRate);
    this.bedRollingRightLowpass = Biquad.lowpass(1400, 0.707, config.sampleRate);
    this.forceLowpass = Biquad.lowpass(360, 0.72, config.sampleRate);
    // The rail itself radiates broadly through the midrange; the car floor and
    // underbody transmission shift the interior maximum below the exterior
    // rail maximum.  Slight L/R offsets prevent an artificial mono resonance.
    this.contactMidLeft = Biquad.bandpass(450, 0.80, config.sampleRate);
    this.contactMidRight = Biquad.bandpass(485, 0.80, config.sampleRate);
    this.contactMidLeftLowpassA = Biquad.lowpass(1500, 0.707, config.sampleRate);
    this.contactMidLeftLowpassB = Biquad.lowpass(1500, 0.707, config.sampleRate);
    this.contactMidRightLowpassA = Biquad.lowpass(1500, 0.707, config.sampleRate);
    this.contactMidRightLowpassB = Biquad.lowpass(1500, 0.707, config.sampleRate);
    // Wheel radiation is concentrated around 1--3 kHz; avoid a higher emphasis
    // that would turn the underfloor-filtered result into synthetic hiss.
    this.contactHighLeft = Biquad.bandpass(2600, 1.05, config.sampleRate);
    this.contactHighRight = Biquad.bandpass(2850, 1.05, config.sampleRate);
    this.contactHighLeftLowpassA = Biquad.lowpass(6500, 0.707, config.sampleRate);
    this.contactHighLeftLowpassB = Biquad.lowpass(6500, 0.707, config.sampleRate);
    this.contactHighRightLowpassA = Biquad.lowpass(6500, 0.707, config.sampleRate);
    this.contactHighRightLowpassB = Biquad.lowpass(6500, 0.707, config.sampleRate);
    this.wheelFieldEnvelopeLeft = new AttackReleaseEnvelope(0.004, 0.040, config.sampleRate);
    this.wheelFieldEnvelopeRight = new AttackReleaseEnvelope(0.004, 0.040, config.sampleRate);
    this.balanceDrift = new NormalizedNoiseLowpass(0.018, config.sampleRate);
    this.trackbedDrift = new NormalizedNoiseLowpass(0.010, config.sampleRate);
  }

  render(frameCount: number): StereoBlock {
    const left = new Float32Array(frameCount);
    const right = new Float32Array(frameCount);
    const cfg = this.config;

    for (let i = 0; i < frameCount; i += 1) {
      // Opposite rails have independent spatial roughness. They share the
      // geometry and defect envelope below, but not the microscopic carrier.
      const roughInputLeft = this.random.bipolar();
      let roughnessLeftLow = 0;
      let roughnessLeftMid = 0;
      let roughnessLeftUpper = 0;
      let roughnessLeftHigh = 0;
      for (let bandIndex = 0; bandIndex < this.roughLeftBands.length; bandIndex += 1) {
        const band = this.roughLeftBands[bandIndex];
        if (band === undefined) continue;
        const value = band.gain * band.filter.process(roughInputLeft);
        if (bandIndex === 0) roughnessLeftLow += value;
        else if (bandIndex <= 3) roughnessLeftMid += value;
        else if (bandIndex === 4) roughnessLeftUpper += value;
        else roughnessLeftHigh += value;
      }
      // Residual long-wavelength conditioning is applied here. The gains of
      // the shorter-wavelength banks already include the measured finite
      // contact-patch roll-off and are kept separate for defect coupling.
      roughnessLeftLow = this.contactPatchLeft.process(
        this.roughLeftHighpass.process(roughnessLeftLow)
      ) * cfg.roughness;
      roughnessLeftMid = this.contactPatchLeftMid.process(roughnessLeftMid) * cfg.roughness;
      roughnessLeftUpper = this.contactPatchLeftUpper.process(roughnessLeftUpper) * cfg.roughness;
      roughnessLeftHigh = this.contactPatchLeftHigh.process(roughnessLeftHigh) * cfg.roughness;
      const roughInputRight = this.random.bipolar();
      let roughnessRightLow = 0;
      let roughnessRightMid = 0;
      let roughnessRightUpper = 0;
      let roughnessRightHigh = 0;
      for (let bandIndex = 0; bandIndex < this.roughRightBands.length; bandIndex += 1) {
        const band = this.roughRightBands[bandIndex];
        if (band === undefined) continue;
        const value = band.gain * band.filter.process(roughInputRight);
        if (bandIndex === 0) roughnessRightLow += value;
        else if (bandIndex <= 3) roughnessRightMid += value;
        else if (bandIndex === 4) roughnessRightUpper += value;
        else roughnessRightHigh += value;
      }
      roughnessRightLow = this.contactPatchRight.process(
        this.roughRightHighpass.process(roughnessRightLow)
      ) * cfg.roughness;
      roughnessRightMid = this.contactPatchRightMid.process(roughnessRightMid) * cfg.roughness;
      roughnessRightUpper = this.contactPatchRightUpper.process(roughnessRightUpper) * cfg.roughness;
      roughnessRightHigh = this.contactPatchRightHigh.process(roughnessRightHigh) * cfg.roughness;

      // Map the dimensionless synthesis profile to micrometre-scale rail
      // roughness before it enters the continuous Hertz contact model.
      const interaction = this.wheelRailContact.process(
        cfg.speedRatio,
        roughnessLeftLow * 38e-6,
        roughnessLeftMid * 38e-6,
        roughnessLeftUpper * 38e-6,
        roughnessLeftHigh * 38e-6,
        roughnessRightLow * 38e-6,
        roughnessRightMid * 38e-6,
        roughnessRightUpper * 38e-6,
        roughnessRightHigh * 38e-6
      );
      // The audible rolling bed is the same rail profile sampled by all four
      // wheel contacts, not a separate noise layer. The gain compensates for
      // the RMS reduction from averaging delayed, partly decorrelated profiles.
      const rollingRoughnessLeft = 1.63 * interaction.effectiveRoughnessLeftM / 38e-6;
      const rollingRoughnessRight = 1.63 * interaction.effectiveRoughnessRightM / 38e-6;
      const bedRollingLeft = this.bedRollingLeftLowpass.process(rollingRoughnessLeft);
      const bedRollingRight = this.bedRollingRightLowpass.process(rollingRoughnessRight);
      // Preserve the power of two incoherent rail profiles. An arithmetic mean
      // would attenuate the low/mid rolling bed by approximately 3 dB.
      const padForce = 0.5 * (
        interaction.normalizedPadForceLeft + interaction.normalizedPadForceRight
      );
      const bedStructure = this.bedModalBank.process(0.52 * padForce);
      const contactStructure = this.contactModalBank.process(
        0.95 * interaction.normalizedForce
      );
      const thump = this.forceLowpass.process(padForce);

      // Radiation paths receive the continuous interaction force and roughness
      // velocity; there is no synthetic impulse carrier.
      // A single rail-seat oscillator is sufficient for the pad/sleeper force
      // split but not for the propagating rail waveguide above a few hundred
      // hertz.  The rail radiation transfer therefore receives contact force,
      // as in TWINS, while the explicit pad oscillator drives the sleeper path.
      // Roughness velocity drives the shorter, wheel-radiated wavelengths.
      const midLeft = this.contactMidLeftLowpassB.process(
        this.contactMidLeftLowpassA.process(
          this.contactMidLeft.process(interaction.normalizedForceLeft)
        )
      );
      const midRight = this.contactMidRightLowpassB.process(
        this.contactMidRightLowpassA.process(
          this.contactMidRight.process(interaction.normalizedForceRight)
        )
      );
      const highLeft = this.contactHighLeftLowpassB.process(
        this.contactHighLeftLowpassA.process(
          this.contactHighLeft.process(interaction.normalizedRoughnessVelocityLeft)
        )
      );
      const highRight = this.contactHighRightLowpassB.process(
        this.contactHighRightLowpassA.process(
          this.contactHighRight.process(interaction.normalizedRoughnessVelocityRight)
        )
      );
      const wheelFieldEnvelopeLeft = this.wheelFieldEnvelopeLeft.process(Math.abs(highLeft));
      const wheelFieldEnvelopeRight = this.wheelFieldEnvelopeRight.process(Math.abs(highRight));

      const independentLeft = this.airLeftLowpass.process(
        this.airLeftHighpass.process(this.random.bipolar())
      );
      const independentRight = this.airRightLowpass.process(
        this.airRightHighpass.process(this.random.bipolar())
      );
      const airGain = cfg.airLevel * 0.035;
      const railCrossfeed = 0.55;
      const railPowerNormalization = 1 / Math.sqrt(1 + railCrossfeed * railCrossfeed);
      const broadLeft = 0.44 * railPowerNormalization * (
        bedRollingLeft + railCrossfeed * bedRollingRight
      );
      const broadRight = 0.44 * railPowerNormalization * (
        bedRollingRight + railCrossfeed * bedRollingLeft
      );
      const rollingSide = 0.5 * (bedRollingLeft - bedRollingRight);
      const rollingSideHigh = this.rollingSideHighpass.process(rollingSide);
      const rawSide = 0.5 * (independentLeft - independentRight);
      const frequencyShapedSide = rawSide - 0.72 * this.sideLowpass.process(rawSide);
      const balanceDrift = 0.0025 * Math.max(-2, Math.min(2, this.balanceDrift.process(this.random.bipolar())));
      const trackbed = Math.max(0.78, Math.min(1.22,
        1 + 0.12 * this.trackbedDrift.process(this.random.bipolar())
      ));

      // The 1.515 kHz line is treated as a low-level electrical/auxiliary
      // candidate. It has tiny wheel-rate FM but is not amplitude-locked to
      // contact events.
      this.auxiliaryShaftPhase += 6.2866 * cfg.speedRatio / cfg.sampleRate;
      if (this.auxiliaryShaftPhase >= 1) this.auxiliaryShaftPhase -= 1;
      const auxiliaryFrequencyHz = 1514.9
        + 0.65 * Math.sin(2 * Math.PI * this.auxiliaryShaftPhase);
      this.auxiliaryElectricalPhase += auxiliaryFrequencyHz / cfg.sampleRate;
      if (this.auxiliaryElectricalPhase >= 1) this.auxiliaryElectricalPhase -= 1;
      const auxiliaryElectrical = 0.0022 * Math.sin(2 * Math.PI * this.auxiliaryElectricalPhase);

      const railSampleLeft = (
        1.00 * broadLeft + 0.130 * railPowerNormalization * (
          midLeft + railCrossfeed * midRight
        )
        + cfg.stereoWidth * (0.05 * rollingSide + 0.22 * rollingSideHigh)
      );
      const railSampleRight = (
        1.00 * broadRight + 0.155 * railPowerNormalization * (
          midRight + railCrossfeed * midLeft
        )
        - cfg.stereoWidth * (0.05 * rollingSide + 0.22 * rollingSideHigh)
      );
      const sleeperSampleLeft = 0.75 * thump
        + 6.0 * cfg.structureLevel * bedStructure.outputLeft;
      const sleeperSampleRight = 0.75 * thump
        + 6.0 * cfg.structureLevel * bedStructure.outputRight;
      const auxiliarySampleLeft = (
        airGain * independentLeft + auxiliaryElectrical + balanceDrift
          + cfg.stereoWidth * 0.01 * airGain * frequencyShapedSide
      );
      const auxiliarySampleRight = (
        airGain * independentRight + 0.92 * auxiliaryElectrical - balanceDrift
          - cfg.stereoWidth * 0.01 * airGain * frequencyShapedSide
      );
      // Crossfeed coefficients are transfer-path parameters: the listener
      // receives a strong near-side wheel field and a quieter opposite-side
      // field through the carbody/cabin. They yield lower coherence at high
      // frequencies while preserving a shared low-frequency structure path.
      const contactSampleLeft = cfg.contactLevel * (
        0.021 * (highLeft + 0.28 * highRight)
          + 0.012 * (
            wheelFieldEnvelopeLeft * independentLeft
              + 0.20 * wheelFieldEnvelopeRight * independentRight
          )
      );
      const contactSampleRight = cfg.contactLevel * (
        0.021 * (highRight + 0.28 * highLeft)
          + 0.012 * (
            wheelFieldEnvelopeRight * independentRight
              + 0.20 * wheelFieldEnvelopeLeft * independentLeft
          )
      );
      const structureSampleLeft = 36.0 * cfg.contactLevel
        * cfg.structureLevel * contactStructure.outputLeft;
      const structureSampleRight = 36.0 * cfg.contactLevel
        * cfg.structureLevel * contactStructure.outputRight;
      let sampleLeft = railSampleLeft + sleeperSampleLeft + auxiliarySampleLeft
        + contactSampleLeft + structureSampleLeft;
      let sampleRight = railSampleRight + sleeperSampleRight + auxiliarySampleRight
        + contactSampleRight + structureSampleRight;

      // The calibrated stream remains linear in normal operation. A final hard
      // bound is retained only as an infinite-stream safety condition; unlike
      // tanh saturation it does not create harmonics below the bound.
      sampleLeft = boundedLinear(this.dcLeft.process(sampleLeft) * cfg.outputGain * trackbed);
      sampleRight = boundedLinear(this.dcRight.process(sampleRight) * cfg.outputGain * trackbed);
      left[i] = sampleLeft;
      right[i] = sampleRight;
    }
    return { left, right };
  }
}
