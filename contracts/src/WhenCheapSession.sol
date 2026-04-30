// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract WhenCheapSession is ReentrancyGuard, Pausable {
    struct SessionPermission {
        uint256 maxFeePerTxWei;
        uint256 maxTotalSpendWei;
        uint256 spentWei;
        uint256 expiresAt;
    }

    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    address public immutable agentAddress;
    address public immutable treasury;
    uint16 public immutable feeBps;
    uint16 public immutable agentFeeSplit;

    mapping(address wallet => SessionPermission) public sessions;

    event SessionAuthorized(
        address indexed wallet,
        uint256 maxFeePerTxWei,
        uint256 maxTotalSpendWei,
        uint256 expiresAt
    );
    event SessionRevoked(address indexed wallet);
    event Executed(address indexed wallet, address indexed to, uint256 value, bytes data);
    event BatchExecuted(address indexed wallet, uint256 callCount);
    event SpendRecorded(address indexed wallet, uint256 feeWei, uint256 totalSpentWei);
    event FeeCollected(address indexed recipient, uint256 feeWei, uint256 totalValue, string feeType);
    event FeeCollectionFailed(address indexed recipient, uint256 feeWei);

    error OnlyAgent();
    error SessionExpired();
    error FeeLimitExceeded();
    error BudgetExceeded();
    error ExecutionFailed(uint256 callIndex);
    error InsufficientValue();
    error ZeroAddress();
    error InvalidDuration();
    error InvalidFee();

    constructor(
        address _agentAddress,
        address _treasury,
        uint16 _feeBps,
        uint16 _agentFeeSplit
    ) {
        if (_agentAddress == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_feeBps > 1000) revert InvalidFee();
        if (_agentFeeSplit > 100) revert InvalidFee();

        agentAddress = _agentAddress;
        treasury = _treasury;
        feeBps = _feeBps;
        agentFeeSplit = _agentFeeSplit;
    }

    function authorize(
        uint256 maxFeePerTxWei,
        uint256 maxTotalSpendWei,
        uint256 durationSeconds
    ) external {
        if (durationSeconds == 0) revert InvalidDuration();
        if (maxFeePerTxWei > maxTotalSpendWei) revert FeeLimitExceeded();

        uint256 expiresAt = block.timestamp + durationSeconds;

        sessions[msg.sender] = SessionPermission({
            maxFeePerTxWei: maxFeePerTxWei,
            maxTotalSpendWei: maxTotalSpendWei,
            spentWei: 0,
            expiresAt: expiresAt
        });

        emit SessionAuthorized(msg.sender, maxFeePerTxWei, maxTotalSpendWei, expiresAt);
    }

    function revokeSession() external {
        delete sessions[msg.sender];
        emit SessionRevoked(msg.sender);
    }

    function canExecute(address wallet, uint256 feeWei) public view returns (bool) {
        SessionPermission storage s = sessions[wallet];
        return block.timestamp < s.expiresAt
            && feeWei <= s.maxFeePerTxWei
            && s.spentWei + feeWei <= s.maxTotalSpendWei;
    }

    function execute(address to, uint256 value, bytes calldata data) external payable nonReentrant whenNotPaused {
        if (msg.sender != agentAddress) revert OnlyAgent();
        if (msg.value < value) revert InsufficientValue();

        (, , uint256 net) = _collectFees(value);

        (bool success,) = to.call{value: net}(data);
        if (!success) revert ExecutionFailed(0);

        emit Executed(address(this), to, net, data);
    }

    function executeBatch(Call[] calldata calls) external payable nonReentrant whenNotPaused {
        if (msg.sender != agentAddress) revert OnlyAgent();

        uint256 totalValue = 0;
        for (uint256 i = 0; i < calls.length; i++) {
            totalValue += calls[i].value;
        }
        if (msg.value < totalValue) revert InsufficientValue();

        for (uint256 i = 0; i < calls.length; i++) {
            (,, uint256 net) = _collectFees(calls[i].value);

            (bool success,) = calls[i].to.call{value: net}(calls[i].data);
            if (!success) revert ExecutionFailed(i);

            emit Executed(address(this), calls[i].to, net, calls[i].data);
        }

        emit BatchExecuted(address(this), calls.length);
    }

    function executeSwap(
        address swapRouter,
        bytes calldata swapCalldata
    ) external payable nonReentrant whenNotPaused {
        if (msg.sender != agentAddress) revert OnlyAgent();
        if (msg.value == 0) revert InsufficientValue();

        (, , uint256 netAmount) = _collectFees(msg.value);

        (bool success,) = swapRouter.call{value: netAmount}(swapCalldata);
        if (!success) revert ExecutionFailed(0);

        emit Executed(address(this), swapRouter, netAmount, swapCalldata);
    }

    function recordSpend(address wallet, uint256 feeWei) external {
        if (msg.sender != agentAddress) revert OnlyAgent();

        SessionPermission storage s = sessions[wallet];
        if (block.timestamp >= s.expiresAt) revert SessionExpired();
        if (feeWei > s.maxFeePerTxWei) revert FeeLimitExceeded();
        if (s.spentWei + feeWei > s.maxTotalSpendWei) revert BudgetExceeded();

        s.spentWei += feeWei;
        emit SpendRecorded(wallet, feeWei, s.spentWei);
    }

    function remainingBudget(address wallet) external view returns (uint256) {
        SessionPermission storage s = sessions[wallet];
        if (block.timestamp >= s.expiresAt) return 0;
        return s.maxTotalSpendWei - s.spentWei;
    }

    function feeForAmount(uint256 value) public view returns (uint256) {
        return (value * feeBps) / 10000;
    }

    function netAfterFee(uint256 value) public view returns (uint256) {
        return value - feeForAmount(value);
    }

    function agentFeeForAmount(uint256 value) public view returns (uint256) {
        uint256 total = feeForAmount(value);
        return (total * agentFeeSplit) / 100;
    }

    function treasuryFeeForAmount(uint256 value) public view returns (uint256) {
        uint256 total = feeForAmount(value);
        uint256 agentFee = agentFeeForAmount(value);
        return total - agentFee;
    }

    function isDelegated(address wallet) external view returns (bool) {
        bytes memory code = wallet.code;
        if (code.length < 23) return false;
        return code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00;
    }

    function pause() external {
        if (msg.sender != agentAddress) revert OnlyAgent();
        _pause();
    }

    function unpause() external {
        if (msg.sender != agentAddress) revert OnlyAgent();
        _unpause();
    }

    receive() external payable {}

    fallback() external payable {}

    function _collectFees(uint256 grossAmount)
        internal
        returns (uint256 totalFee, uint256 agentFee, uint256 netAmount)
    {
        totalFee = feeForAmount(grossAmount);
        agentFee = agentFeeForAmount(grossAmount);
        uint256 treasuryFee = treasuryFeeForAmount(grossAmount);
        netAmount = grossAmount - totalFee;

        if (agentFee > 0) {
            (bool agentOk,) = agentAddress.call{value: agentFee}("");
            if (!agentOk) {
                emit FeeCollectionFailed(agentAddress, agentFee);
            } else {
                emit FeeCollected(agentAddress, agentFee, grossAmount, "agent");
            }
        }

        if (treasuryFee > 0) {
            (bool treasuryOk,) = treasury.call{value: treasuryFee}("");
            if (!treasuryOk) {
                emit FeeCollectionFailed(treasury, treasuryFee);
            } else {
                emit FeeCollected(treasury, treasuryFee, grossAmount, "treasury");
            }
        }
    }
}
