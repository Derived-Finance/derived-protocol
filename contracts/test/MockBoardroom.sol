pragma solidity ^0.6.0;

import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/token/ERC20/SafeERC20.sol';

import '../owner/Operator.sol';
import '../interfaces/IBoardroom.sol';

contract MockBoardroom is IBoardroom, Operator {
    using SafeERC20 for IERC20;

    /* ========== STATE VARIABLES ========== */

    IERC20 public dbtc;

    /* ========== CONSTRUCTOR ========== */

    constructor(address _dbtc) public {
        dbtc = IERC20(_dbtc);
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    function allocateSeigniorage(uint256 amount)
        external
        override
        onlyOperator
    {
        require(amount > 0, 'Boardroom: Cannot allocate 0');
        dbtc.safeTransferFrom(msg.sender, address(this), amount);
        emit RewardAdded(msg.sender, amount);
    }

    /* ========== EVENTS ========== */

    event RewardAdded(address indexed user, uint256 reward);
}
