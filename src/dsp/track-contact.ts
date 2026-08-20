import { NormalizedNoiseLowpass } from "./filters.js";
import type { Xoshiro128 } from "./random.js";

interface WheelRailContactOutput {
  /** Sum of dynamic Hertzian forces, relative to the static wheel loads. */
  normalizedForce: number;
  /** Dynamic force from the left/right rail paths, before cabin crossfeed. */
  normalizedForceLeft: number;
  normalizedForceRight: number;
  /** Dynamic force transmitted through the rail pad into sleeper/trackbed. */
  normalizedPadForceLeft: number;
  normalizedPadForceRight: number;
  /** Vertical roughness velocity, normalized for acoustic transfer filters. */
  normalizedRoughnessVelocityLeft: number;
  normalizedRoughnessVelocityRight: number;
  /** Combined effective roughness seen by the four contact points. */
  effectiveRoughnessLeftM: number;
  effectiveRoughnessRightM: number;
}

class ContinuousHertzContact {
  private wheelPositionM = 0;
  private wheelVelocityMps = 0;
  private railPositionM = 0;
  private railVelocityMps = 0;
  private readonly staticCompressionM: number;
  normalizedForce = 0;
  normalizedPadForce = 0;

  // The 68 GN/m^(3/2) Hertz coefficient gives a linearized contact stiffness
  // close to 950 MN/m at the chosen 55 kN static load (Thompson/Pieren model).
  private readonly hertzCoefficient = 68e9;
  private readonly wheelMassKg = 350;
  private readonly staticLoadN = 55_000;
  private readonly suspensionStiffnessNpm = 0.85e6;
  private readonly suspensionDampingNsPm = 16_000;
  // One rail seat's local vertical response.  60 kg and 120 MN/m place the
  // rail-on-pad resonance near 225 Hz, within published ballasted-track ranges.
  // The continuum rail is represented later by broadband radiation filters;
  // this oscillator supplies the local rail/pad force split in real time.
  private readonly effectiveRailMassKg = 60;
  private readonly railPadStiffnessNpm = 120e6;
  private readonly railPadDampingNsPm = 21_200;

  constructor(private readonly sampleRate: number) {
    this.staticCompressionM = Math.pow(this.staticLoadN / this.hertzCoefficient, 2 / 3);
  }

  process(surfaceHeightM: number): void {
    const compressionM = Math.max(
      0,
      this.staticCompressionM + surfaceHeightM
        - this.wheelPositionM - this.railPositionM
    );
    const contactForceN = this.hertzCoefficient * Math.pow(compressionM, 1.5);
    const dynamicContactForceN = contactForceN - this.staticLoadN;
    const accelerationMps2 = (
      dynamicContactForceN
      - this.suspensionStiffnessNpm * this.wheelPositionM
      - this.suspensionDampingNsPm * this.wheelVelocityMps
    ) / this.wheelMassKg;
    const padForceN = this.railPadStiffnessNpm * this.railPositionM
      + this.railPadDampingNsPm * this.railVelocityMps;
    const railAccelerationMps2 = (
      dynamicContactForceN - padForceN
    ) / this.effectiveRailMassKg;
    // Semi-implicit Euler is stable here because the audio rate is much higher
    // than the linearized wheel/contact resonance.
    this.wheelVelocityMps += accelerationMps2 / this.sampleRate;
    this.wheelPositionM += this.wheelVelocityMps / this.sampleRate;
    this.railVelocityMps += railAccelerationMps2 / this.sampleRate;
    this.railPositionM += this.railVelocityMps / this.sampleRate;
    this.normalizedForce = Math.max(-1, Math.min(4, dynamicContactForceN / this.staticLoadN));
    this.normalizedPadForce = Math.max(-2, Math.min(4, padForceN / this.staticLoadN));
  }
}

/**
 * Continuous wheel/rail rolling excitation.
 *
 * One spatial rail profile is stored in a delay line and sampled by four
 * effective wheel contacts. At 18 m/s their offsets are 0, 1.91, 5.75 and
 * 7.66 m: a plausible axle/bogie geometry inferred from the measured rates,
 * but not a unique identification of the source vehicle. Each contact also
 * adds its own repeating wheel-roundness profile. No recorded audio is used.
 */
export class WheelRailContact {
  private readonly profileDelayLeft: Float64Array;
  private readonly profileDelayRight: Float64Array;
  private delayWriteIndex = 0;
  private readonly contactsLeft: readonly ContinuousHertzContact[];
  private readonly contactsRight: readonly ContinuousHertzContact[];
  private readonly wheelPhasesLeft = [0.07, 0.31, 0.58, 0.83];
  private readonly wheelPhasesRight = [0.18, 0.44, 0.69, 0.92];
  private readonly wheelRateRatiosLeft = [1, 0.994, 1.007, 1.002];
  private readonly wheelRateRatiosRight = [1.003, 0.997, 1.005, 0.992];
  private groupPhase = 0.18;
  private bogiePhase = 0.61;
  private axlePhase = 0.37;
  private profileHuntPhase = 0.23;
  private readonly groupWander: NormalizedNoiseLowpass;
  private readonly levelWander: NormalizedNoiseLowpass;
  private previousEffectiveRoughnessLeftM = 0;
  private previousEffectiveRoughnessRightM = 0;
  private defectDepthDb = 15.0;
  private defectCenterPhase = 0.5;
  private readonly output: WheelRailContactOutput = {
    normalizedForce: 0,
    normalizedForceLeft: 0,
    normalizedForceRight: 0,
    normalizedPadForceLeft: 0,
    normalizedPadForceRight: 0,
    normalizedRoughnessVelocityLeft: 0,
    normalizedRoughnessVelocityRight: 0,
    effectiveRoughnessLeftM: 0,
    effectiveRoughnessRightM: 0,
  };

  private readonly longPatchRateHz = 0.8179;
  private readonly bogieSpatialRateHz = 3.1311;
  private readonly wheelRotationRateHz = 6.2866;
  private readonly axleSpatialRateHz = 9.4167;
  private readonly contactDelaysAtNominalSpeed = [
    0,
    0.10524,
    0.31070,
    0.41594,
  ];
  // Event folding of the reference reveals three clearly audible axle arrivals
  // at 0, 0.106 and 0.311 s, with a much weaker fourth arrival around 0.426 s.
  // The weights model source/listener distance without suppressing the bogie
  // sequence by averaging it into a single event.
  private readonly contactWeights = [0.32, 0.32, 0.30, 0.06];

  constructor(
    private readonly sampleRate: number,
    private readonly random: Xoshiro128
  ) {
    this.profileDelayLeft = new Float64Array(Math.ceil(sampleRate * 0.9));
    this.profileDelayRight = new Float64Array(Math.ceil(sampleRate * 0.9));
    this.contactsLeft = Array.from({ length: 4 }, () => new ContinuousHertzContact(sampleRate));
    this.contactsRight = Array.from({ length: 4 }, () => new ContinuousHertzContact(sampleRate));
    this.groupWander = new NormalizedNoiseLowpass(0.045, sampleRate);
    this.levelWander = new NormalizedNoiseLowpass(0.018, sampleRate);
  }

  private advancePhase(phase: number, rateHz: number, speedRatio: number): number {
    phase += rateHz * speedRatio / this.sampleRate;
    return phase >= 1 ? phase - 1 : phase;
  }

  private delayedProfile(
    profile: Float64Array,
    delaySeconds: number,
    speedRatio: number
  ): number {
    const delaySamples = Math.round(delaySeconds / speedRatio * this.sampleRate);
    const index = (this.delayWriteIndex - delaySamples + profile.length) % profile.length;
    return profile[index] ?? 0;
  }

  process(
    speedRatio: number,
    railRoughnessLeftLowM: number,
    railRoughnessLeftMidM: number,
    railRoughnessLeftUpperM: number,
    railRoughnessLeftHighM: number,
    railRoughnessRightLowM: number,
    railRoughnessRightMidM: number,
    railRoughnessRightUpperM: number,
    railRoughnessRightHighM: number
  ): WheelRailContactOutput {
    const wander = Math.max(-2, Math.min(2,
      this.groupWander.process(this.random.bipolar())
    ));
    const previousGroupPhase = this.groupPhase;
    this.groupPhase = this.advancePhase(
      previousGroupPhase,
      this.longPatchRateHz * (1 + 0.0090 * wander),
      speedRatio
    );
    if (this.groupPhase < previousGroupPhase) {
      // The next rail patch is related but not identical to the previous one.
      this.defectDepthDb = 13.5 + 3.5 * Math.abs(this.random.bipolar());
      this.defectCenterPhase = 0.5 + 0.055 * this.random.bipolar();
    }
    this.bogiePhase = this.advancePhase(this.bogiePhase, this.bogieSpatialRateHz, speedRatio);
    this.axlePhase = this.advancePhase(this.axlePhase, this.axleSpatialRateHz, speedRatio);
    this.profileHuntPhase = this.advancePhase(this.profileHuntPhase, 0.071, speedRatio);

    const longPatch = 0.5 - 0.5 * Math.cos(2 * Math.PI * this.groupPhase);
    const signedDistanceFromPatchCenter = this.groupPhase - this.defectCenterPhase;
    // The measured event rises faster than it decays. A smooth asymmetric
    // defect envelope gives about 17 ms to half-height on approach and 50 ms
    // after the peak; it remains continuous and differentiable at the peak.
    // The delayed contacts cross this same area in the measured axle sequence.
    const patchSigma = signedDistanceFromPatchCenter < 0 ? 0.012 : 0.035;
    const localRoughnessPatch = Math.exp(
      -0.5 * Math.pow(signedDistanceFromPatchCenter / patchSigma, 2)
    );
    const bogieTexture = Math.sin(2 * Math.PI * this.bogiePhase);
    const axleTexture = Math.sin(2 * Math.PI * this.axlePhase);
    const levelDrift = Math.max(-2, Math.min(2,
      this.levelWander.process(this.random.bipolar())
    ));
    // A broad raised-cosine roughness field surrounds the localized defect.
    // Its approximately 0.6 s half-prominence width is measured independently
    // of the much shorter axle events.
    const baseTextureDb = 1.50 * longPatch
      + 0.48 * bogieTexture
      + 0.22 * axleTexture
      + 0.16 * levelDrift;
    const baseTextureGain = Math.pow(10, baseTextureDb / 20);
    const localDefectGain = Math.pow(
      10,
      this.defectDepthDb * localRoughnessPatch / 20
    );
    // A finite rail defect contains proportionally more short-wavelength
    // roughness. Long wavelengths therefore receive no local amplitude rise,
    // the 125 Hz region 35%, and wavelengths mapped above
    // roughly 200 Hz receive the full rise. This reproduces the measured
    // 2 dB low-frequency event versus 6--8 dB wheel-radiation event.
    const localExcess = localDefectGain - 1;
    const lowDefectGain = 1;
    const midDefectGain = 1 + 0.62 * localExcess;
    // The reference's 1--2.5 kHz bands rise much less at each defect than its
    // 2.5--5 kHz wheel field.  Keeping this wavelength family separate avoids
    // treating every local defect as a broadband digital gain change.
    const upperDefectGain = 1 + 0.23 * localExcess;
    const highDefectGain = 1 + 2.0 * localExcess;
    this.profileDelayLeft[this.delayWriteIndex] = baseTextureGain * (
      lowDefectGain * railRoughnessLeftLowM
        + midDefectGain * railRoughnessLeftMidM
        + upperDefectGain * railRoughnessLeftUpperM
        + highDefectGain * railRoughnessLeftHighM
    );
    this.profileDelayRight[this.delayWriteIndex] = baseTextureGain * (
      lowDefectGain * railRoughnessRightLowM
        + midDefectGain * railRoughnessRightMidM
        + upperDefectGain * railRoughnessRightUpperM
        + highDefectGain * railRoughnessRightHighM
    );

    let forceLeft = 0;
    let forceRight = 0;
    let padForceLeft = 0;
    let padForceRight = 0;
    let effectiveRoughnessLeftM = 0;
    let effectiveRoughnessRightM = 0;
    for (let contact = 0; contact < this.contactsLeft.length; contact += 1) {
      // Sub-millisecond time variation represents the changing lateral line
      // through each finite contact patch (wheelset hunting). It is negligible
      // for the measured axle arrival times, but prevents exact delayed copies
      // of stochastic roughness from creating a non-physical comb spectrum.
      const huntDelayLeft = 0.00048 * Math.sin(
        2 * Math.PI * (this.profileHuntPhase + 0.217 * contact)
      );
      const huntDelayRight = 0.00048 * Math.sin(
        2 * Math.PI * (this.profileHuntPhase + 0.217 * contact + 0.41)
      );
      const nominalDelay = this.contactDelaysAtNominalSpeed[contact] ?? 0;
      const delayedRailLeftM = this.delayedProfile(
        this.profileDelayLeft,
        Math.max(0, nominalDelay + huntDelayLeft),
        speedRatio
      );
      const delayedRailRightM = this.delayedProfile(
        this.profileDelayRight,
        Math.max(0, nominalDelay + huntDelayRight),
        speedRatio
      );
      const wheelPhaseLeft = this.advancePhase(
        this.wheelPhasesLeft[contact] ?? 0,
        this.wheelRotationRateHz * (this.wheelRateRatiosLeft[contact] ?? 1),
        speedRatio
      );
      const wheelPhaseRight = this.advancePhase(
        this.wheelPhasesRight[contact] ?? 0,
        this.wheelRotationRateHz * (this.wheelRateRatiosRight[contact] ?? 1),
        speedRatio
      );
      this.wheelPhasesLeft[contact] = wheelPhaseLeft;
      this.wheelPhasesRight[contact] = wheelPhaseRight;
      // Micrometre-scale wheel roundness: fundamental plus two higher orders.
      // It is deliberately weaker than the localized rail defect: the 6.29 Hz
      // order is measurable in the reference, but is not its dominant rhythm.
      const wheelRoughnessLeftM = 0.42e-6 * Math.sin(2 * Math.PI * wheelPhaseLeft)
        + 0.15e-6 * Math.sin(4 * Math.PI * wheelPhaseLeft + 0.7)
        + 0.07e-6 * Math.sin(8 * Math.PI * wheelPhaseLeft + 1.9);
      const wheelRoughnessRightM = 0.42e-6 * Math.sin(2 * Math.PI * wheelPhaseRight)
        + 0.15e-6 * Math.sin(4 * Math.PI * wheelPhaseRight + 0.9)
        + 0.07e-6 * Math.sin(8 * Math.PI * wheelPhaseRight + 2.2);
      const combinedLeftM = delayedRailLeftM + wheelRoughnessLeftM;
      const combinedRightM = delayedRailRightM + wheelRoughnessRightM;
      const weight = this.contactWeights[contact] ?? 0;
      effectiveRoughnessLeftM += weight * combinedLeftM;
      effectiveRoughnessRightM += weight * combinedRightM;
      const contactLeft = this.contactsLeft[contact];
      const contactRight = this.contactsRight[contact];
      if (contactLeft === undefined || contactRight === undefined) continue;
      contactLeft.process(combinedLeftM);
      contactRight.process(combinedRightM);
      forceLeft += weight * contactLeft.normalizedForce;
      forceRight += weight * contactRight.normalizedForce;
      padForceLeft += weight * contactLeft.normalizedPadForce;
      padForceRight += weight * contactRight.normalizedPadForce;
    }
    this.delayWriteIndex = (this.delayWriteIndex + 1) % this.profileDelayLeft.length;

    const roughnessVelocityLeftMps = (
      effectiveRoughnessLeftM - this.previousEffectiveRoughnessLeftM
    ) * this.sampleRate;
    const roughnessVelocityRightMps = (
      effectiveRoughnessRightM - this.previousEffectiveRoughnessRightM
    ) * this.sampleRate;
    this.previousEffectiveRoughnessLeftM = effectiveRoughnessLeftM;
    this.previousEffectiveRoughnessRightM = effectiveRoughnessRightM;
    const force = 0.5 * (forceLeft + forceRight);
    // Keep this path linear: clipping low-frequency roughness velocity before
    // radiation would create false broadband harmonics and erase contrast.
    const normalizedRoughnessVelocityLeft = roughnessVelocityLeftMps / 0.012;
    const normalizedRoughnessVelocityRight = roughnessVelocityRightMps / 0.012;
    this.output.normalizedForce = force;
    this.output.normalizedForceLeft = forceLeft;
    this.output.normalizedForceRight = forceRight;
    this.output.normalizedPadForceLeft = padForceLeft;
    this.output.normalizedPadForceRight = padForceRight;
    this.output.normalizedRoughnessVelocityLeft = normalizedRoughnessVelocityLeft;
    this.output.normalizedRoughnessVelocityRight = normalizedRoughnessVelocityRight;
    this.output.effectiveRoughnessLeftM = effectiveRoughnessLeftM;
    this.output.effectiveRoughnessRightM = effectiveRoughnessRightM;
    return this.output;
  }
}
