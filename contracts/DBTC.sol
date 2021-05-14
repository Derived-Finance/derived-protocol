pragma solidity ^0.6.0;

import '@openzeppelin/contracts/token/ERC20/ERC20Burnable.sol';
import './owner/Operator.sol';

contract DBTC is ERC20Burnable, Operator {
    /**
     * @notice Constructs the DBTC ERC-20 contract.
     */
    constructor() public ERC20('DBTC', 'DBTC') {
        _mint(msg.sender, 10**12); // 100 sat for uniswap pair
    }

    /**
     * @notice Operator mints DBTC to a recipient
     * @param recipient_ The address of recipient
     * @param amount_ The amount of DBTC to mint to
     * @return whether the process has been done
     */
    function mint(address recipient_, uint256 amount_)
        public
        onlyOperator
        returns (bool)
    {
        uint256 balanceBefore = balanceOf(recipient_);
        _mint(recipient_, amount_);
        uint256 balanceAfter = balanceOf(recipient_);

        return balanceAfter > balanceBefore;
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
