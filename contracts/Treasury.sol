pragma solidity ^0.6.0;

import '@openzeppelin/contracts/math/Math.sol';
import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/token/ERC20/SafeERC20.sol';
import '@openzeppelin/contracts/utils/ReentrancyGuard.sol';

import './interfaces/IOracle.sol';
import './interfaces/IBoardroom.sol';
import './interfaces/IDerivedAsset.sol';
import './interfaces/ISimpleERCFund.sol';
import './lib/Babylonian.sol';
import './lib/FixedPoint.sol';
import './lib/Safe112.sol';
import './owner/Operator.sol';
import './utils/Epoch.sol';
import './utils/ContractGuard.sol';

/**
 * @title DBTC Treasury contract
 * @notice Monetary policy logic to adjust supplies of DBTC assets
 * @author Summer Smith & Rick Sanchez
 */
contract Treasury is ContractGuard, Epoch {
    using FixedPoint for *;
    using SafeERC20 for IERC20;
    using Address for address;
    using SafeMath for uint256;
    using Safe112 for uint112;

    /* ========== STATE VARIABLES ========== */

    // ========== FLAGS
    bool public migrated = false;
    bool public initialized = false;

    // ========== CORE
    address public devfund;
    address public stablefund;
    address public dbtc;
    address public dbond;
    address public derived;
    address public boardroom;

    address public dbondOracle;
    address public seigniorageOracle;

    // ========== PARAMS
    uint256 public constant dbtcOneUnit = 1e18;
    uint256 public constant wbtcOneUnit = 1e8;
    uint256 public dbtcPriceCeiling; // sat / eth
    uint256 private accumulatedSeigniorage = 0;
    uint256 public devfundAllocationRate = 2; // %
    uint256 public stablefundAllocationRate = 50; // %

    /* ========== CONSTRUCTOR ========== */

    constructor(
        address _dbtc,
        address _dbond,
        address _derived,
        address _dbondOracle,
        address _seigniorageOracle,
        address _boardroom,
        address _devfund,
        address _stablefund,
        uint256 _startTime,
        uint256 _period
    ) public Epoch(_period, _startTime, 0) {
        dbtc = _dbtc;
        dbond = _dbond;
        derived = _derived;
        dbondOracle = _dbondOracle;
        seigniorageOracle = _seigniorageOracle;

        boardroom = _boardroom;
        devfund = _devfund;
        stablefund = _stablefund;

        dbtcPriceCeiling = uint256(105).mul(wbtcOneUnit).div(10**2);
    }

    /* =================== Modifier =================== */

    modifier checkMigration {
        require(!migrated, 'Treasury: migrated');

        _;
    }

    modifier checkOperator {
        require(
            IDerivedAsset(dbtc).operator() == address(this) &&
                IDerivedAsset(dbond).operator() == address(this) &&
                IDerivedAsset(derived).operator() == address(this) &&
                Operator(boardroom).operator() == address(this),
            'Treasury: need more permission'
        );

        _;
    }

    /* ========== VIEW FUNCTIONS ========== */

    // budget
    function getReserve() public view returns (uint256) {
        return accumulatedSeigniorage;
    }

    // sat / eth
    function getdbondOraclePrice() public view returns (uint256) {
        return _getDBTCPrice(dbondOracle);
    }

    // sat / eth
    function getSeigniorageOraclePrice() public view returns (uint256) {
        return _getDBTCPrice(seigniorageOracle);
    }

    // sat / eth
    function _getDBTCPrice(address oracle) internal view returns (uint256) {
        try IOracle(oracle).consult(dbtc, dbtcOneUnit) returns (uint256 price) {
            return price;
        } catch {
            revert('Treasury: failed to consult dbtc price from the oracle');
        }
    }

    /* ========== GOVERNANCE ========== */

    function initialize() public checkOperator {
        require(!initialized, 'Treasury: initialized');

        // burn all of it's balance
        IDerivedAsset(dbtc).burn(IERC20(dbtc).balanceOf(address(this)));

        // set accumulatedSeigniorage to it's balance
        accumulatedSeigniorage = IERC20(dbtc).balanceOf(address(this));

        initialized = true;
        emit Initialized(msg.sender, block.number);
    }

    function migrate(address target) public onlyOperator checkOperator {
        require(!migrated, 'Treasury: migrated');

        // dbtc
        Operator(dbtc).transferOperator(target);
        Operator(dbtc).transferOwnership(target);
        IERC20(dbtc).transfer(target, IERC20(dbtc).balanceOf(address(this)));

        // dbond
        Operator(dbond).transferOperator(target);
        Operator(dbond).transferOwnership(target);
        IERC20(dbond).transfer(target, IERC20(dbond).balanceOf(address(this)));

        // derived
        Operator(derived).transferOperator(target);
        Operator(derived).transferOwnership(target);
        IERC20(derived).transfer(target, IERC20(derived).balanceOf(address(this)));

        migrated = true;
        emit Migration(target);
    }

    function setDevFund(address newFund) public onlyOperator {
        devfund = newFund;
        emit DevFundChanged(msg.sender, newFund);
    }

    function setDevFundAllocationRate(uint256 rate) public onlyOperator {
        devfundAllocationRate = rate;
        emit DevFundRateChanged(msg.sender, rate);
    }

    function setStableFund(address newFund) public onlyOperator {
        stablefund = newFund;
        emit StableFundChanged(msg.sender, newFund);
    }

    function setStableFundAllocationRate(uint256 rate) public onlyOperator {
        stablefundAllocationRate = rate;
        emit StableFundRateChanged(msg.sender, rate);
    }

    function setdBTCPriceCeiling(uint256 percentage) public onlyOperator {
        dbtcPriceCeiling = percentage.mul(wbtcOneUnit).div(10**2);
    }

    /* ========== MUTABLE FUNCTIONS ========== */

    function _updateDBTCPrice() internal {
        try IOracle(dbondOracle).update() {} catch {}
        try IOracle(seigniorageOracle).update() {} catch {}
    }

    function buyDbonds(uint256 amount, uint256 targetPrice)
        external
        onlyOneBlock
        checkMigration
        checkStartTime
        checkOperator
    {
        require(
            amount > 0,
            'Treasury: cannot purchase dbonds with zero amount'
        );

        uint256 dbondPrice = getDbondOraclePrice(); // sat / eth
        require(dbondPrice == targetPrice, 'Treasury: dbtc price moved');
        require(
            dbondPrice < wbtcOneUnit,
            'Treasury: dbtcPrice not eligible for dbond purchase'
        );

        IDerivedAsset(dbtc).burnFrom(msg.sender, amount);
        IDerivedAsset(dbond).mint(
            msg.sender,
            amount.mul(wbtcOneUnit).div(dbondPrice)
        );
        _updateDBTCPrice();

        emit BoughtDbonds(msg.sender, amount);
    }

    function redeemDbonds(uint256 amount, uint256 targetPrice)
        external
        onlyOneBlock
        checkMigration
        checkStartTime
        checkOperator
    {
        require(amount > 0, 'Treasury: cannot redeem dbonds with zero amount');

        uint256 dbtcPrice = _getDBTCPrice(dbondOracle);
        require(dbtcPrice == targetPrice, 'Treasury: dbtc price moved');
        require(
            dbtcPrice > dbtcPriceCeiling,
            'Treasury: dbtcPrice not eligible for dbond purchase'
        );
        require(
            IERC20(dbtc).balanceOf(address(this)) >= amount,
            'Treasury: treasury has no more budget'
        );

        accumulatedSeigniorage = accumulatedSeigniorage.sub(
            Math.min(accumulatedSeigniorage, amount)
        );

        IDerivedAsset(dbond).burnFrom(msg.sender, amount);
        IERC20(dbtc).safeTransfer(msg.sender, amount);
        _updatedBTCPrice();

        emit Redeemeddbonds(msg.sender, amount);
    }

    function allocateSeigniorage()
        external
        onlyOneBlock
        checkMigration
        checkStartTime
        checkEpoch
        checkOperator
    {
        _updateDBTCPrice();
        uint256 dbtcPrice = getSeigniorageOraclePrice();
        if (dbtcPrice <= dbtcPriceCeiling) {
            return;
        }

        uint256 dbtcSupply =
            IERC20(dbtc).totalSupply().sub(accumulatedSeigniorage); //wei
        uint256 percentage = dbtcPrice.sub(wbtcOneUnit); // sat
        uint256 seigniorage = dbtcSupply.mul(percentage).div(wbtcOneUnit); // wei
        IDerivedAsset(dbtc).mint(address(this), seigniorage);

        uint256 devfundReserve =
            seigniorage.mul(devfundAllocationRate).div(100);
        if (devfundReserve > 0) {
            IERC20(dbtc).safeApprove(devfund, devfundReserve);
            ISimpleERCFund(devfund).deposit(
                dbtc,
                devfundReserve,
                'Treasury: Seigniorage Allocation'
            );
            emit DevFundFunded(now, devfundReserve);
        }

        seigniorage = seigniorage.sub(devfundReserve);

        // fixed reserve for Bond
        uint256 treasuryReserve =
            Math.min(
                seigniorage,
                IERC20(dbond).totalSupply().sub(accumulatedSeigniorage)
            );
        if (treasuryReserve > 0) {
            accumulatedSeigniorage = accumulatedSeigniorage.add(
                treasuryReserve
            );
            emit TreasuryFunded(now, treasuryReserve);
        }

        seigniorage = seigniorage.sub(treasuryReserve);

        uint256 stablefundReserve =
            seigniorage.mul(stablefundAllocationRate).div(100);
        if (stablefundReserve > 0) {
            IERC20(dbtc).safeTransfer(stablefund, stablefundReserve);
            emit StableFundFunded(now, stablefundReserve);
        }
        seigniorage = seigniorage.sub(stablefundReserve);

        // boardroom
        uint256 boardroomReserve = seigniorage;
        if (boardroomReserve > 0) {
            IERC20(dbtc).safeApprove(boardroom, boardroomReserve);
            IBoardroom(boardroom).allocateSeigniorage(boardroomReserve);
            emit BoardroomFunded(now, boardroomReserve);
        }
    }

    // GOV
    event Initialized(address indexed executor, uint256 at);
    event Migration(address indexed target);
    event DevFundChanged(address indexed operator, address newFund);
    event DevFundRateChanged(address indexed operator, uint256 newRate);
    event StableFundChanged(address indexed operator, address newFund);
    event StableFundRateChanged(address indexed operator, uint256 newRate);

    // CORE
    event RedeemedDbonds(address indexed from, uint256 amount);
    event BoughtDbonds(address indexed from, uint256 amount);
    event TreasuryFunded(uint256 timestamp, uint256 seigniorage);
    event BoardroomFunded(uint256 timestamp, uint256 seigniorage);
    event DevFundFunded(uint256 timestamp, uint256 seigniorage);
    event StableFundFunded(uint256 timestamp, uint256 seigniorage);
}
