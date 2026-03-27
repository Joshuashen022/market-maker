import { JsonRpcProvider } from "ethers/providers";

export function getProvider(rpcUrl: string): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl, undefined, {
    polling: false,
    staticNetwork: true,
  });
}