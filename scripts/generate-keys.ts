import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { Contract, JsonRpcProvider, Wallet, ethers} from "ethers";
import "dotenv/config";
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
];

const COUNT = 30;
const OUT_PATH = path.join(process.cwd(), "config", "generated-keys.json");
const ERC20_ADDRESS = "0x11ae382abBC595CF801eAc09cd1818956341c61d";
function generateKeys() {
  const keys = Array.from({ length: COUNT }, () => {
    const w = Wallet.createRandom();
    return { privateKey: w.privateKey, address: w.address };
  });

  writeFileSync(OUT_PATH, JSON.stringify(keys, null, 2) + "\n", "utf8");
  console.log(`Wrote ${keys.length} key(s) to ${OUT_PATH}`);
}

async function fundKeys() {
  const privateKey = process.env.PRIVATE_KEY! || "";
  const url = process.env.RPC_URL|| "https://eth-sepolia.api.onfinality.io/public";
  const erc20_amount = ethers.parseUnits("1000", 18);
  const ether_amount = ethers.parseUnits("0.3", 18);
  console.log(`ERC20 amount: ${erc20_amount}, Ether amount: ${ether_amount}`);
  const provider = new JsonRpcProvider(url);
  const wallet = new Wallet(privateKey, provider);
  const erc20 = new Contract(ERC20_ADDRESS, ERC20_ABI, wallet);
  const keys = JSON.parse(readFileSync(OUT_PATH, "utf8"));
  console.log(`Initialized key ${wallet.address} with balance ${
    ethers.formatUnits(await erc20.balanceOf(wallet.address), 18)
  }, ${ethers.formatUnits(await provider.getBalance(wallet.address), 18)}`);
  for (const key of keys) {
    const w = new Wallet(key.privateKey, provider);
    const ethBalance = await provider.getBalance(key.address);
    const erc20Balance = await erc20.balanceOf(key.address);
    
    console.log(`Initialized key ${key.address} with balance ${ethers.formatUnits(erc20Balance, 18)}, ${ethers.formatUnits(ethBalance, 18)}`);
    if (erc20Balance < erc20_amount) {
      console.log(`Transferring ${erc20_amount - erc20Balance} ERC20 to ${key.address}`);
      const tx = await erc20.transfer(key.address, erc20_amount - erc20Balance);
      await tx.wait();
      const newErc20Balance = await erc20.balanceOf(key.address);
      console.log(`New ERC20 balance: ${ethers.formatUnits(newErc20Balance, 18)}`);
    }

    if (ethBalance < ether_amount) {
      console.log(`Transferring ${ether_amount - ethBalance} Ether to ${key.address}`);
      const tx = await wallet.sendTransaction({
        to: key.address,
        value: ether_amount - ethBalance,
      });
      await tx.wait();
      const newEthBalance = await provider.getBalance(key.address);
      console.log(`New Ether balance: ${ethers.formatUnits(newEthBalance, 18)}`);
    }
  }
}

async function checkKeys() {
  const privateKey = process.env.PRIVATE_KEY! || "";
  const url = process.env.RPC_URL|| "https://eth-sepolia.api.onfinality.io/public";
  const provider = new JsonRpcProvider(url);
  const wallet = new Wallet(privateKey, provider);
  const erc20 = new Contract(ERC20_ADDRESS, ERC20_ABI, wallet);
  const keys = JSON.parse(readFileSync(OUT_PATH, "utf8"));

  for (const key of keys) {
    const w = new Wallet(key.privateKey, provider);
    const ethBalance = await provider.getBalance(w.address);
    const erc20Balance = await erc20.balanceOf(w.address);
    
    console.log(`Initialized key ${w.address} with balance ${ethers.formatUnits(erc20Balance, 18)}, ${ethers.formatUnits(ethBalance, 18)}`);
  }
}

function main() {
  checkKeys();
}

main();
