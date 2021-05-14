pragma solidity ^0.6.0;

import '@openzeppelin/contracts/math/SafeMath.sol';
import '@openzeppelin/contracts/token/ERC20/IERC20.sol';

import '../interfaces/IDistributor.sol';
import '../interfaces/IRewardDistributionRecipient.sol';

contract InitialDRVDistributor is IDistributor {
    using SafeMath for uint256;

    event Distributed(address pool, uint256 kbtcAmount);

    bool public once = true;

    IERC20 public derived;
    IRewardDistributionRecipient public wbtcdbtcLPPool;
    uint256 public wbtcdbtcInitialBalance;
    IRewardDistributionRecipient public wbtcdrvLPPool;
    uint256 public wbtcdrvInitialBalance;

    constructor(
        IERC20 _derived,
        IRewardDistributionRecipient _wbtcdbtcLPPool,
        uint256 _wbtcdbtcInitialBalance,
        IRewardDistributionRecipient _wbtcdrvLPPool,
        uint256 _wbtcdrvInitialBalance
    ) public {
        klon = _derived;
        wbtcdbtcLPPool = _wbtcdbtcLPPool;
        wbtcdbtcInitialBalance = _wbtcdbtcInitialBalance;
        wbtcdrvLPPool = _wbtcdrvLPPool;
        wbtcdrvInitialBalance = _wbtcdrvInitialBalance;
    }

    function distribute() public override {
        require(
            once,
            'InitialDRVDistributor: you cannot run this function twice'
        );

        derived.transfer(address(wbtcdbtcLPPool), wbtcdbtcInitialBalance);
        wbtcdbtcLPPool.notifyRewardAmount(wbtcdbtcInitialBalance);
        emit Distributed(address(wbtcdbtcLPPool), wbtcdbtcInitialBalance);

        derived.transfer(address(wbtcdrvLPPool), wbtcdrvInitialBalance);
        wbtcdrvLPPool.notifyRewardAmount(wbtcdrvInitialBalance);
        emit Distributed(address(wbtcdrvLPPool), wbtcdrvInitialBalance);

        once = false;
    }
}
