pragma solidity ^0.6.0;

import './owner/Operator.sol';
import '@openzeppelin/contracts/token/ERC20/ERC20Burnable.sol';

contract Derived is ERC20Burnable, Operator {
    constructor() public ERC20('DRV', 'DRV') {
        _mint(msg.sender, 10**12); // 100 sat for uniswap pair
    }

    /**
     * @notice Operator mints DBTC to a recipient
     * @param recipient_ The address of recipient
     * @param amount_ The amount of DBTC to mint to
     */
    function mint(address recipient_, uint256 amount_)
        public
        onlyOperator
        returns (bool)
    {
        uint256 balanceBefore = balanceOf(recipient_);
        _mint(recipient_, amount_);
        uint256 balanceAfter = balanceOf(recipient_);
        return balanceAfter >= balanceBefore;
    }

    function burn(uint256 amount) public override onlyOperator {
        super.burn(amount);
    }

    function burnFrom(address account, uint256 amount)
        public
        override
        onlyOperator
    {
        super.burnFrom(account, amount);
    }
}
