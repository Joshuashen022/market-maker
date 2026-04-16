# Sample Hardhat 3 Beta Project (`mocha` and `ethers`)

This project showcases a Hardhat 3 Beta project using `mocha` for tests and the `ethers` library for Ethereum interactions.

To learn more about the Hardhat 3 Beta, please visit the [Getting Started guide](https://hardhat.org/docs/getting-started#getting-started-with-hardhat-3). To share your feedback, join our [Hardhat 3 Beta](https://hardhat.org/hardhat3-beta-telegram-group) Telegram group or [open an issue](https://github.com/NomicFoundation/hardhat/issues/new) in our GitHub issue tracker.

## Project Overview

This example project includes:

- A simple Hardhat configuration file.
- Foundry-compatible Solidity unit tests.
- TypeScript integration tests using `mocha` and ethers.js
- Examples demonstrating how to connect to different types of networks, including locally simulating OP mainnet.

## Usage

### Running Tests

To run all the tests in the project, execute the following command:

```shell
npx hardhat test
```

You can also selectively run the Solidity or `mocha` tests:

```shell
npx hardhat test solidity
npx hardhat test mocha
```

### Make a deployment to Sepolia

This project includes an example Ignition module to deploy the contract. You can deploy this module to a locally simulated chain or to Sepolia.

To run the deployment to a local chain:

```shell
npx hardhat ignition deploy ignition/modules/Counter.ts
```

To run the deployment to Sepolia, you need an account with funds to send the transaction. The provided Hardhat configuration includes a Configuration Variable called `SEPOLIA_PRIVATE_KEY`, which you can use to set the private key of the account you want to use.

You can set the `SEPOLIA_PRIVATE_KEY` variable using the `hardhat-keystore` plugin or by setting it as an environment variable.

To set the `SEPOLIA_PRIVATE_KEY` config variable using `hardhat-keystore`:

```shell
npx hardhat keystore set SEPOLIA_PRIVATE_KEY
```

After setting the variable, you can run the deployment with the Sepolia network:

```shell
npx hardhat ignition deploy --network sepolia ignition/modules/Counter.ts
```




# 模拟交易机器人策略

| 项 | 策略 |
| --- | --- |
| 单笔交易额(以eth计价，完全随机) | *   2$-50$  90%<br>    <br>*   50$-100$  10% |
| 买卖单数量占比 | *   买单 55%<br>    <br>*   卖单 45%<br>    <br>*   连续买<5笔<br>    <br>*   连续卖<5笔 |
| 交易时间间隔 | *   10–40s：30%<br>    <br>*   40–80s：50%<br>    <br>*   80–120s：20%<br>    <br>以上为1m线样式，考虑到uniswap的价格线样式，频次可适度降低<br>*   150–300s：30%<br>    <br>*   300-600s：50%<br>    <br>*   600-1200s：20% |
| 震荡区间 | *   超过 +5%：只允许卖<br>    <br>*   低于 -5%：只允许买 |
| 价格锚定 | 30分钟内加权平均价（2分钟更新一次） |
| 日内成交量上限 | *   日成交量 ≤ TVL × 80% |
| Gas 与成本控制参数 | *   gas limit：固定 30万<br>    <br>*   不使用 max 值 |
| 滑点区间 | *   买单 0.8% ~ 1.5%<br>    <br>*   卖单 0.6% ~ 1.2% |
| 执行钱包 | *   数量：30个<br>    <br>*   单钱包连续交易 ≤ 5 笔<br>    <br>*   钱包随机轮换 |
| 备注 | 涉及到概率完全随机 |



# 可视化交易界面（个人需求）

1. 能动态调整交易参数： 初始化config之后，提供界面可以重载部分（全部）参数，实现动态调整策略的功能
2. 展示价格波动图，可以动态监视所有交易的价格波动
3. 展示策略交易图，能显示所有执行的交易
4. 展示池子的基本信息，并且提供手动交易接口
5. 提供其他分析的信息接口，方便后续制定策略
6. 可扩展功能，代码和界面要支持续增加新功能