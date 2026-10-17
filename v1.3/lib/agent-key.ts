import { createAccount, generatePrivateKey } from "genlayer-js";

// A separate agent wallet generated in this browser so one person can play both roles
// (the vault forbids owner == agent). The key never leaves this browser's localStorage;
// it is test-only and the UI says so before creating it.
const STORAGE_KEY = "trustgate.v13.agentKey";

export type AgentKey = { privateKey: `0x${string}`; address: `0x${string}` };

function read(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function loadAgentKey(): AgentKey | null {
  const key = read();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  return { privateKey: key as `0x${string}`, address: createAccount(key as `0x${string}`).address as `0x${string}` };
}

export function createAgentKey(): AgentKey {
  const privateKey = generatePrivateKey();
  try {
    window.localStorage.setItem(STORAGE_KEY, privateKey);
  } catch {
    throw new Error("This browser blocks local storage, so the agent key cannot be kept. Use an external agent address instead.");
  }
  return { privateKey, address: createAccount(privateKey).address as `0x${string}` };
}

export function importAgentKey(text: string): AgentKey {
  const key = text.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("That is not a private key (0x followed by 64 hex characters).");
  try {
    window.localStorage.setItem(STORAGE_KEY, key);
  } catch {
    throw new Error("This browser blocks local storage.");
  }
  return { privateKey: key as `0x${string}`, address: createAccount(key as `0x${string}`).address as `0x${string}` };
}

export function forgetAgentKey() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {}
}
