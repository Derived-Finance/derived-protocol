pragma solidity ^0.6.0;

import '../distribution/DBTCWBTCPool.sol';
// import '../distribution/KBTCWBTCPool.sol';
// import '../distribution/KBTCSUSDPool.sol';
// import '../distribution/KBTCUSDCPool.sol';
// import '../distribution/KBTCUSDTPool.sol';
// import '../distribution/KBTCyCRVPool.sol';
import '../interfaces/IDistributor.sol';

contract InitialDBTCDistributor is IDistributor {
    using SafeMath for uint256;

    event Distributed(address pool, uint256 dbtcAmount);

    bool public once = true;

    IERC20 public dbtc;
    IRewardDistributionRecipient[] public pools;
    uint256 public totalInitialBalance;

    constructor(
        IERC20 _dbtc,
        IRewardDistributionRecipient[] memory _pools,
        uint256 _totalInitialBalance
    ) public {
        require(_pools.length != 0, 'a list of DBTC pools are required');

        dbtc = _dbtc;
        pools = _pools;
        totalInitialBalance = _totalInitialBalance;
    }

    function distribute() public override {
        require(
            once,
            'InitialDBTCDistributor: you cannot run this function twice'
        );

        for (uint256 i = 0; i < pools.length; i++) {
            uint256 amount = totalInitialBalance.div(pools.length);

            dbtc.transfer(address(pools[i]), amount);
            pools[i].notifyRewardAmount(amount);

            emit Distributed(address(pools[i]), amount);
        }

        once = false;
    }
}
