import { encode } from 'silk-wasm';

export async function silkVoiceFixture(frames = 5): Promise<Buffer> {
  const pcm = Buffer.alloc(frames * 960);
  for (let i = 0; i < pcm.length / 2; i += 1) {
    pcm.writeInt16LE(Math.round(5000 * Math.sin(i * 2 * Math.PI * 440 / 24_000)), i * 2);
  }
  return Buffer.from((await encode(pcm, 24_000)).data);
}
