import chai, { expect } from 'chai';
import { ethers } from 'hardhat';
import { solidity } from 'ethereum-waffle';
import {
  Contract,
  ContractFactory,
  BigNumber,
  utils,
  BigNumberish,
} from 'ethers';
import { Provider } from '@ethersproject/providers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import { advanceTimeAndBlock } from './shared/utilities';

chai.use(solidity);

const DAY = 86400;
const ETH = utils.parseEther('1');
const BTC = BigNumber.from(10).pow(8);
const ZERO = BigNumber.from(0);
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const INITIAL_BAC_AMOUNT = utils.parseEther('50000');
const INITIAL_BAS_AMOUNT = utils.parseEther('10000');
const INITIAL_BAB_AMOUNT = utils.parseEther('50000');

async function latestBlocktime(provider: Provider): Promise<number> {
  const { timestamp } = await provider.getBlock('latest');
  return timestamp;
}

function bigmin(a: BigNumber, b: BigNumber): BigNumber {
  return a.lt(b) ? a : b;
}

describe('Treasury', () => {
  const { provider } = ethers;

  let operator: SignerWithAddress;
  let ant: SignerWithAddress;

  before('provider & accounts setting', async () => {
    [operator, ant] = await ethers.getSigners();
  });

  // core
  let Kbond: ContractFactory;
  let KBTC: ContractFactory;
  let Klon: ContractFactory;
  let Treasury: ContractFactory;
  let SimpleFund: ContractFactory;
  let MockOracle: ContractFactory;
  let MockBoardroom: ContractFactory;

  before('fetch contract factories', async () => {
    Kbond = await ethers.getContractFactory('Kbond');
    KBTC = await ethers.getContractFactory('KBTC');
    Klon = await ethers.getContractFactory('Klon');
    Treasury = await ethers.getContractFactory('Treasury');
    SimpleFund = await ethers.getContractFactory('SimpleERCFund');
    MockOracle = await ethers.getContractFactory('MockOracle');
    MockBoardroom = await ethers.getContractFactory('MockBoardroom');
  });

  let bond: Contract;
  let cash: Contract;
  let share: Contract;
  let oracle: Contract;
  let treasury: Contract;
  let boardroom: Contract;
  let fund: Contract;
  let stableFund: Contract;

  let startTime: BigNumber;

  beforeEach('deploy contracts', async () => {
    cash = await KBTC.connect(operator).deploy();
    bond = await Kbond.connect(operator).deploy();
    share = await Klon.connect(operator).deploy();
    oracle = await MockOracle.connect(operator).deploy();
    boardroom = await MockBoardroom.connect(operator).deploy(cash.address);
    fund = await SimpleFund.connect(operator).deploy();
    stableFund = await SimpleFund.connect(operator).deploy();

    startTime = BigNumber.from(await latestBlocktime(provider)).add(DAY);
    treasury = await Treasury.connect(operator).deploy(
      cash.address,
      bond.address,
      share.address,
      oracle.address,
      oracle.address,
      boardroom.address,
      fund.address,
      stableFund.address,
      startTime,
      DAY
    );
    await fund.connect(operator).transferOperator(treasury.address);
  });

  describe('governance', () => {
    let newTreasury: Contract;

    beforeEach('deploy new treasury', async () => {
      newTreasury = await Treasury.connect(operator).deploy(
        cash.address,
        bond.address,
        share.address,
        oracle.address,
        oracle.address,
        boardroom.address,
        fund.address,
        fund.address,
        await latestBlocktime(provider),
        DAY
      );

      for await (const token of [cash, bond, share]) {
        await token.connect(operator).mint(treasury.address, ETH);
        await token.connect(operator).transferOperator(treasury.address);
        await token.connect(operator).transferOwnership(treasury.address);
      }
      await boardroom.connect(operator).transferOperator(treasury.address);
    });

    describe('#initialize', () => {
      it('should works correctly', async () => {
        await treasury.connect(operator).migrate(newTreasury.address);
        await boardroom.connect(operator).transferOperator(newTreasury.address);

        await expect(newTreasury.initialize())
          .to.emit(newTreasury, 'Initialized')
          .to.emit(cash, 'Transfer')
          .withArgs(newTreasury.address, ZERO_ADDR, ETH)
          .to.emit(cash, 'Transfer');

        expect(await newTreasury.getReserve()).to.eq(ZERO);
      });

      it('should fail if newTreasury is not the operator of core contracts', async () => {
        await boardroom.connect(operator).transferOperator(ant.address);
        await expect(newTreasury.initialize()).to.revertedWith(
          'Treasury: need more permission'
        );
      });

      it('should fail if abuser tries to initialize twice', async () => {
        await treasury.connect(operator).migrate(newTreasury.address);
        await boardroom.connect(operator).transferOperator(newTreasury.address);

        await newTreasury.initialize();
        await expect(newTreasury.initialize()).to.revertedWith(
          'Treasury: initialized'
        );
      });
    });

    describe('#migrate', () => {
      it('should works correctly', async () => {
        await expect(treasury.connect(operator).migrate(newTreasury.address))
          .to.emit(treasury, 'Migration')
          .withArgs(newTreasury.address);

        for await (const token of [cash, bond, share]) {
          expect(await token.balanceOf(newTreasury.address)).to.eq(ETH);
          expect(await token.owner()).to.eq(newTreasury.address);
          expect(await token.operator()).to.eq(newTreasury.address);
        }
      });

      it('should fail if treasury is not the operator of core contracts', async () => {
        await boardroom.connect(operator).transferOperator(ant.address);
        await expect(
          treasury.connect(operator).migrate(newTreasury.address)
        ).to.revertedWith('Treasury: need more permission');
      });

      it('should fail if already migrated', async () => {
        await treasury.connect(operator).migrate(newTreasury.address);
        await boardroom.connect(operator).transferOperator(newTreasury.address);

        await newTreasury.connect(operator).migrate(treasury.address);
        await boardroom.connect(operator).transferOperator(treasury.address);

        await expect(
          treasury.connect(operator).migrate(newTreasury.address)
        ).to.revertedWith('Treasury: migrated');
      });
    });
  });

  describe('seigniorage', () => {
    describe('#allocateSeigniorage', () => {
      beforeEach('transfer permissions', async () => {
        await bond.mint(operator.address, INITIAL_BAB_AMOUNT);
        await cash.mint(operator.address, INITIAL_BAC_AMOUNT);
        await cash.mint(treasury.address, INITIAL_BAC_AMOUNT);
        await share.mint(operator.address, INITIAL_BAS_AMOUNT);
        for await (const contract of [cash, bond, share, boardroom]) {
          await contract.connect(operator).transferOperator(treasury.address);
        }
      });

      describe('after migration', () => {
        it('should fail if contract migrated', async () => {
          for await (const contract of [cash, bond, share]) {
            await contract
              .connect(operator)
              .transferOwnership(treasury.address);
          }

          await treasury.connect(operator).migrate(operator.address);
          expect(await treasury.migrated()).to.be.true;

          await expect(treasury.allocateSeigniorage()).to.revertedWith(
            'Treasury: migrated'
          );
        });
      });

      describe('before startTime', () => {
        it('should fail if not started yet', async () => {
          await expect(treasury.allocateSeigniorage()).to.revertedWith(
            'Epoch: not started yet'
          );
        });
      });

      describe('after startTime', () => {
        beforeEach('advance blocktime', async () => {
          // wait til first epoch
          await advanceTimeAndBlock(
            provider,
            startTime.sub(await latestBlocktime(provider)).toNumber()
          );
        });

        it('should funded correctly', async () => {
          const cashPrice = BTC.mul(210).div(100);
          await oracle.setPrice(cashPrice);

          // calculate with circulating supply
          const treasuryHoldings = await treasury.getReserve();
          const cashSupply = (await cash.totalSupply()).sub(treasuryHoldings);
          const expectedSeigniorage = cashSupply
            .mul(cashPrice.sub(BTC))
            .div(BTC);

            // get all expected reserve
          const expectedDevFundReserve = expectedSeigniorage
            .mul(await treasury.devfundAllocationRate())
            .div(100);

          const expectedTreasuryReserve = bigmin(
            expectedSeigniorage.sub(expectedDevFundReserve),
            (await bond.totalSupply()).sub(treasuryHoldings)
          );
          
          const leftover = expectedSeigniorage
          .sub(expectedDevFundReserve)
          .sub(expectedTreasuryReserve);

          const expectedStableFundReserve = leftover.mul(await treasury.stablefundAllocationRate()).div(100);

          const expectedBoardroomReserve = leftover
            .sub(expectedStableFundReserve);

          const allocationResult = await treasury.allocateSeigniorage();

          if (expectedDevFundReserve.gt(ZERO)) {
            await expect(new Promise((resolve) => resolve(allocationResult)))
              .to.emit(treasury, 'DevFundFunded')
              .withArgs(await latestBlocktime(provider), expectedDevFundReserve);
          }

          if (expectedTreasuryReserve.gt(ZERO)) {
            await expect(new Promise((resolve) => resolve(allocationResult)))
              .to.emit(treasury, 'TreasuryFunded')
              .withArgs(
                await latestBlocktime(provider),
                expectedTreasuryReserve
              );
          }

          if (expectedStableFundReserve.gt(ZERO)) {
            await expect(new Promise((resolve) => resolve(allocationResult)))
              .to.emit(treasury, 'StableFundFunded')
              .withArgs(
                await latestBlocktime(provider),
                expectedStableFundReserve
              );
          }

          if (expectedBoardroomReserve.gt(ZERO)) {
            await expect(new Promise((resolve) => resolve(allocationResult)))
              .to.emit(treasury, 'BoardroomFunded')
              .withArgs(
                await latestBlocktime(provider),
                expectedBoardroomReserve
              );
          }

          expect(await cash.balanceOf(fund.address)).to.eq(expectedDevFundReserve);
          expect(await cash.balanceOf(stableFund.address)).to.eq(expectedStableFundReserve);
          expect(await treasury.getReserve()).to.eq(expectedTreasuryReserve);
          expect(await cash.balanceOf(boardroom.address)).to.eq(
            expectedBoardroomReserve
          );
        });

        it('should funded even fails to call update function in oracle', async () => {
          const cashPrice = ETH.mul(106).div(100);
          await oracle.setRevert(true);
          await oracle.setPrice(cashPrice);

          await expect(treasury.allocateSeigniorage()).to.emit(
            treasury,
            'TreasuryFunded'
          );
        });

        it('should move to next epoch after allocation', async () => {
          const cashPrice1 = ETH.mul(106).div(100);
          await oracle.setPrice(cashPrice1);

          expect(await treasury.getCurrentEpoch()).to.eq(BigNumber.from(0));
          expect(await treasury.nextEpochPoint()).to.eq(startTime);

          await treasury.allocateSeigniorage();
          expect(await treasury.getCurrentEpoch()).to.eq(BigNumber.from(1));
          expect(await treasury.nextEpochPoint()).to.eq(startTime.add(DAY));

          await advanceTimeAndBlock(
            provider,
            Number(await treasury.nextEpochPoint()) -
              (await latestBlocktime(provider))
          );

          const cashPrice2 = ETH.mul(104).div(100);
          await oracle.setPrice(cashPrice2);

          await treasury.allocateSeigniorage();
          expect(await treasury.getCurrentEpoch()).to.eq(BigNumber.from(2));
          expect(await treasury.nextEpochPoint()).to.eq(startTime.add(DAY * 2));
        });

        describe('should fail', () => {
          it('if treasury is not the operator of core contract', async () => {
            const cashPrice = ETH.mul(106).div(100);
            await oracle.setPrice(cashPrice);

            for await (const target of [cash, bond, share, boardroom]) {
              await target.connect(operator).transferOperator(ant.address);
              await expect(treasury.allocateSeigniorage()).to.revertedWith(
                'Treasury: need more permission'
              );
            }
          });

          it('if seigniorage already allocated in this epoch', async () => {
            const cashPrice = ETH.mul(106).div(100);
            await oracle.setPrice(cashPrice);
            await treasury.allocateSeigniorage();
            await expect(treasury.allocateSeigniorage()).to.revertedWith(
              'Epoch: not allowed'
            );
          });
        });
      });
    });
  });

  describe('bonds', async () => {
    beforeEach('transfer permissions', async () => {
      await cash.mint(operator.address, INITIAL_BAC_AMOUNT);
      await bond.mint(operator.address, INITIAL_BAB_AMOUNT);
      for await (const contract of [cash, bond, share, boardroom]) {
        await contract.connect(operator).transferOperator(treasury.address);
      }
    });

    describe('after migration', () => {
      it('should fail if contract migrated', async () => {
        for await (const contract of [cash, bond, share]) {
          await contract.connect(operator).transferOwnership(treasury.address);
        }

        await treasury.connect(operator).migrate(operator.address);
        expect(await treasury.migrated()).to.be.true;

        await expect(treasury.buyKbonds(ETH, ETH)).to.revertedWith(
          'Treasury: migrated'
        );
        await expect(treasury.redeemKbonds(ETH, ETH)).to.revertedWith(
          'Treasury: migrated'
        );
      });
    });

    describe('before startTime', () => {
      it('should fail if not started yet', async () => {
        await expect(treasury.buyKbonds(ETH, ETH)).to.revertedWith(
          'Epoch: not started yet'
        );
        await expect(treasury.redeemKbonds(ETH, ETH)).to.revertedWith(
          'Epoch: not started yet'
        );
      });
    });

    describe('after startTime', () => {
      beforeEach('advance blocktime', async () => {
        // wait til first epoch
        await advanceTimeAndBlock(
          provider,
          startTime.sub(await latestBlocktime(provider)).toNumber()
        );
      });

      describe('#buyKbonds', () => {
        it('should work if cash price below $1', async () => {
          const cashPrice = BTC.mul(99).div(100); // $0.99
          await oracle.setPrice(cashPrice);
          await cash.connect(operator).transfer(ant.address, ETH);
          await cash.connect(ant).approve(treasury.address, ETH);

          await expect(treasury.connect(ant).buyKbonds(ETH, cashPrice))
            .to.emit(treasury, 'BoughtKbonds')
            .withArgs(ant.address, ETH);

          expect(await cash.balanceOf(ant.address)).to.eq(ZERO);
          expect(await bond.balanceOf(ant.address)).to.eq(
            ETH.mul(BTC).div(cashPrice)
          );
        });

        it('should fail if cash price over $1', async () => {
          const cashPrice = BTC.mul(101).div(100); // $1.01
          await oracle.setPrice(cashPrice);
          await cash.connect(operator).transfer(ant.address, ETH);
          await cash.connect(ant).approve(treasury.address, ETH);

          await expect(
            treasury.connect(ant).buyKbonds(ETH, cashPrice)
          ).to.revertedWith(
            'Treasury: kbtcPrice not eligible for kbond purchase'
          );
        });

        it('should fail if price changed', async () => {
          const cashPrice = BTC.mul(99).div(100); // $0.99
          await oracle.setPrice(cashPrice);
          await cash.connect(operator).transfer(ant.address, ETH);
          await cash.connect(ant).approve(treasury.address, ETH);

          await expect(
            treasury.connect(ant).buyKbonds(ETH, ETH)
          ).to.revertedWith('Treasury: kbtc price moved');
        });

        it('should fail if purchase bonds with zero amount', async () => {
          const cashPrice = BTC.mul(99).div(100); // $0.99
          await oracle.setPrice(cashPrice);

          await expect(
            treasury.connect(ant).buyKbonds(ZERO, cashPrice)
          ).to.revertedWith('Treasury: cannot purchase kbonds with zero amount');
        });
      });
      describe('#redeemKbonds', () => {
        beforeEach('allocate seigniorage to treasury', async () => {
          const cashPrice = BTC.mul(106).div(100);
          await oracle.setPrice(cashPrice);
          await treasury.allocateSeigniorage();
          await advanceTimeAndBlock(
            provider,
            Number(await treasury.nextEpochPoint()) -
              (await latestBlocktime(provider))
          );
        });

        it('should work if cash price exceeds $1.05', async () => {
          const cashPrice = BTC.mul(106).div(100);
          await oracle.setPrice(cashPrice);

          await bond.connect(operator).transfer(ant.address, ETH);
          await bond.connect(ant).approve(treasury.address, ETH);
          await expect(treasury.connect(ant).redeemKbonds(ETH, cashPrice))
            .to.emit(treasury, 'RedeemedKbonds')
            .withArgs(ant.address, ETH);

          expect(await bond.balanceOf(ant.address)).to.eq(ZERO); // 1:1
          expect(await cash.balanceOf(ant.address)).to.eq(ETH);
        });

        it("should drain over seigniorage and even contract's budget", async () => {
          const cashPrice = BTC.mul(106).div(100);
          await oracle.setPrice(cashPrice);

          await cash.connect(operator).transfer(treasury.address, ETH); // $1002

          const treasuryBalance = await cash.balanceOf(treasury.address);
          await bond.connect(operator).transfer(ant.address, treasuryBalance);
          await bond.connect(ant).approve(treasury.address, treasuryBalance);
          await treasury.connect(ant).redeemKbonds(treasuryBalance, cashPrice);

          expect(await bond.balanceOf(ant.address)).to.eq(ZERO);
          expect(await cash.balanceOf(ant.address)).to.eq(treasuryBalance); // 1:1
        });

        it('should fail if price changed', async () => {
          const cashPrice = BTC.mul(106).div(100);
          await oracle.setPrice(cashPrice);

          await bond.connect(operator).transfer(ant.address, ETH);
          await bond.connect(ant).approve(treasury.address, ETH);
          await expect(
            treasury.connect(ant).redeemKbonds(ETH, ETH)
          ).to.revertedWith('Treasury: kbtc price moved');
        });

        it('should fail if redeem bonds with zero amount', async () => {
          const cashPrice = BTC.mul(106).div(100);
          await oracle.setPrice(cashPrice);

          await expect(
            treasury.connect(ant).redeemKbonds(ZERO, cashPrice)
          ).to.revertedWith('Treasury: cannot redeem kbonds with zero amount');
        });

        it('should fail if cash price is below $1+??', async () => {
          const cashPrice = BTC.mul(104).div(100);
          await oracle.setPrice(cashPrice);

          await bond.connect(operator).transfer(ant.address, ETH);
          await bond.connect(ant).approve(treasury.address, ETH);
          await expect(
            treasury.connect(ant).redeemKbonds(ETH, cashPrice)
          ).to.revertedWith(
            'Treasury: kbtcPrice not eligible for kbond purchase'
          );
        });

        it("should fail if redeem bonds over contract's budget", async () => {
          const cashPrice = BTC.mul(106).div(100);
          await oracle.setPrice(cashPrice);

          const treasuryBalance = await cash.balanceOf(treasury.address);
          const redeemAmount = treasuryBalance.add(ETH);
          await bond.connect(operator).transfer(ant.address, redeemAmount);
          await bond.connect(ant).approve(treasury.address, redeemAmount);

          await expect(
            treasury.connect(ant).redeemKbonds(redeemAmount, cashPrice)
          ).to.revertedWith('Treasury: treasury has no more budget');
        });
      });
    });
  });
});
