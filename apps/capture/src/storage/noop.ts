import type { StorageWriter } from "./types.js";

export class NoopStorageWriter implements StorageWriter {
  async writePacket(): Promise<void> {
    // intentionally empty
  }
}
