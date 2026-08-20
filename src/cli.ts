import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { FloatWavWriter, interleaveF32, writeWithBackpressure } from "./audio-io.js";
import { TrainAmbienceGenerator } from "./generator.js";
import { defaultConfig } from "./model.js";

const command = process.argv[2] ?? "render";
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    seconds: { type: "string", default: "180" },
    out: { type: "string", default: "output/train-ambience.wav" },
    seed: { type: "string" },
    speed: { type: "string", default: "1" },
    "block-size": { type: "string", default: "16384" },
    help: { type: "boolean", short: "h" }
  },
  strict: true
});

if (values.help || !["render", "stream"].includes(command)) {
  process.stdout.write(`Usage:
  pnpm render --seconds 180 --out output/train.wav [--seed 123] [--speed 1]
  pnpm stream [--seed 123] [--speed 1] | ffplay -f f32le -ar 44100 -ac 2 -

The seed is random by default; pass --seed to reproduce a render.
The stream command is intentionally unbounded; stop it with Ctrl-C.\n`);
  process.exit(values.help ? 0 : 1);
}

const numberOption = (name: string, value: string | undefined): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${name}: ${value}`);
  return parsed;
};

const seed = values.seed === undefined
  ? randomBytes(4).readUInt32LE(0)
  : numberOption("seed", values.seed) >>> 0;
const speedRatio = numberOption("speed", values.speed);
const blockSize = Math.max(64, Math.floor(numberOption("block-size", values["block-size"])));
if (speedRatio < 0.5 || speedRatio > 2) throw new Error("--speed must be in [0.5, 2]");

const config = { ...defaultConfig, seed, speedRatio };
const generator = new TrainAmbienceGenerator(config);

if (command === "render") {
  const seconds = numberOption("seconds", values.seconds);
  if (seconds <= 0) throw new Error("--seconds must be positive");
  const frameCount = Math.round(seconds * config.sampleRate);
  const outputPath = resolve(values.out);
  if (!outputPath.toLowerCase().endsWith(".wav")) throw new Error("--out must end with .wav");
  mkdirSync(dirname(outputPath), { recursive: true });
  const writer = new FloatWavWriter(outputPath, config.sampleRate, frameCount);
  let remaining = frameCount;
  while (remaining > 0) {
    const count = Math.min(blockSize, remaining);
    writer.write(generator.render(count));
    remaining -= count;
  }
  writer.close();
  process.stderr.write(`Rendered ${seconds.toFixed(2)} s to ${outputPath} (seed=${seed})\n`);
} else {
  process.stderr.write(
    `Streaming stereo f32le at ${config.sampleRate} Hz (seed=${seed}, speed=${speedRatio}); Ctrl-C to stop.\n`
  );
  while (true) {
    await writeWithBackpressure(process.stdout, interleaveF32(generator.render(blockSize)));
  }
}
