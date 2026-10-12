import { useEffect, useState } from "react";
import { invoke } from "../oriel";

/** What this build can scan with (fixed per build). Whether the device has
 *  the model is each provider's own status. */
export interface Capabilities {
  /** Fast local matching: the "pantry.vision" extension (Android). */
  fastLocal: boolean;
  /** System AI: oriel.system_ai (Android, iOS). */
  systemAi: boolean;
  /** The provider a new install starts with. */
  defaultProvider: string;
}

const outsideApp: Capabilities = {
  fastLocal: false,
  systemAi: false,
  defaultProvider: "local",
};

let pending: Promise<Capabilities> | null = null;

export function loadCapabilities(): Promise<Capabilities> {
  if (!window.oriel) return Promise.resolve(outsideApp);
  pending ??= invoke("capabilities")
    .then((caps) => ({
      ...caps,
      // Oriel's own table for the module; the command says the same.
      systemAi: caps.systemAi && window.oriel.features?.systemAi !== false,
    }))
    .catch((error: unknown) => {
      console.warn("Could not read capabilities", error);
      pending = null;
      return outsideApp;
    });
  return pending;
}

export function useCapabilities(): Capabilities | null {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  useEffect(() => {
    let live = true;
    void loadCapabilities().then((next) => {
      if (live) setCaps(next);
    });
    return () => {
      live = false;
    };
  }, []);
  return caps;
}
