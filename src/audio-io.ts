import { once } from "node:events";
import { closeSync, openSync, writeSync } from "node:fs";
import type { Writable } from "node:stream";
import type { StereoBlock } from "./generator.js";

function wavHeader(sampleRate: number, frameCount: number): Buffer {
  const channels = 2;
  const bytesPerSample = 4;
  const dataBytes = frameCount * channels * bytesPerSample;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); // IEEE float
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

export function interleaveF32(block: StereoBlock): Buffer {
  const output = Buffer.allocUnsafe(block.left.length * 8);
  for (let i = 0; i < block.left.length; i += 1) {
    output.writeFloatLE(block.left[i] ?? 0, i * 8);
    output.writeFloatLE(block.right[i] ?? 0, i * 8 + 4);
  }
  return output;
}

export class FloatWavWriter {
  private readonly fd: number;
  private writtenFrames = 0;

  constructor(path: string, sampleRate: number, private readonly frameCount: number) {
    this.fd = openSync(path, "w");
    writeSync(this.fd, wavHeader(sampleRate, frameCount));
  }

  write(block: StereoBlock): void {
    if (block.left.length !== block.right.length) {
      throw new Error("WAV writer requires equal left/right channel lengths");
    }
    if (this.writtenFrames + block.left.length > this.frameCount) {
      throw new Error("WAV writer received more frames than declared");
    }
    writeSync(this.fd, interleaveF32(block));
    this.writtenFrames += block.left.length;
  }

  close(): void {
    closeSync(this.fd);
    if (this.writtenFrames !== this.frameCount) {
      throw new Error(`WAV incomplete: wrote ${this.writtenFrames}/${this.frameCount} frames`);
    }
  }
}

export async function writeWithBackpressure(stream: Writable, data: Buffer): Promise<void> {
  if (!stream.write(data)) await once(stream, "drain");
}
