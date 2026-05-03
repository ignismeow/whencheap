// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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

    mapping(address => SessionPermission) public sessions;
    mapping(address => uint256) public deposits;

    event SessionAuthorized(
        address indexed wallet,
        uint256 maxFeePerTxWei,
        uint256 maxTotalSpendWei,
        uint256 expiresAt
    );
    event SessionRevoked(address indexed wallet, uint256 refundAmount);
    event Deposited(address indexed wallet, uint256 amount);
    event Withdrawn(address indexed wallet, uint256 amount);
    event Executed(address indexed wallet, address indexed to, uint256 value, bytes data);
    event BatchExecuted(address indexed wallet, uint256 callCount);
    event SpendRecorded(address indexed wallet, uint256 feeWei, uint256 totalSpentWei);
    event FeeCollected(address indexed recipient, uint256 feeWei, uint256 totalValue, string feeType);
    event FeeCollectionFailed(address indexed recipient, uint256 feeWei);
    event EmergencyWithdrawn(address indexed to, uint256 amount);
    event TokensForwarded(address indexed token, address indexed to, uint256 amount);
    event TokensRescued(address indexed token, address indexed to, uint256 amount);

    error OnlyAgent();
    error SessionExpired();
    error FeeLimitExceeded();
    error BudgetExceeded();
    error ExecutionFailed(uint256 callIndex);
    error InsufficientDeposit(uint256 have, uint256 need);
    error ZeroAddress();
    error InvalidDuration();
    error InvalidFee();
    error WithdrawFailed();
    error SessionNotExpired();

    modifier onlyAgent() {
        if (msg.sender != agentAddress) revert OnlyAgent();
        _;
    }

    constructor(address _agentAddress, address _treasury, uint16 _feeBps, uint16 _agentFeeSplit) {
        if (_agentAddress == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_feeBps > 1000) revert InvalidFee();
        if (_agentFeeSplit > 100) revert InvalidFee();

        agentAddress = _agentAddress;
        treasury = _treasury;
        feeBps = _feeBps;
        agentFeeSplit = _agentFeeSplit;
    }

    // ── Deposits ──────────────────────────────────────────────────────────────

    function deposit() external payable {
        require(msg.value > 0, "zero deposit");
        deposits[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external nonReentrant {
        require(deposits[msg.sender] >= amount, "insufficient deposit");
        deposits[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ── Session management ────────────────────────────────────────────────────

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

    function revokeSession() external nonReentrant {
        uint256 refund = deposits[msg.sender];
        delete sessions[msg.sender];

        if (refund > 0) {
            deposits[msg.sender] = 0;
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert WithdrawFailed();
            emit Withdrawn(msg.sender, refund);
        }

        emit SessionRevoked(msg.sender, refund);
    }

    // ── Agent execution ───────────────────────────────────────────────────────

    function execute(
        address wallet,
        address to,
        uint256 value,
        bytes calldata data
    ) external nonReentrant whenNotPaused onlyAgent {
        uint256 bal = deposits[wallet];
        if (bal < value) revert InsufficientDeposit(bal, value);

        deposits[wallet] -= value;

        (,, uint256 net) = _collectFees(value);

        (bool ok,) = to.call{value: net}(data);
        if (!ok) revert ExecutionFailed(0);

        emit Executed(wallet, to, net, data);
    }

    function executeBatch(
        address wallet,
        Call[] calldata calls
    ) external nonReentrant whenNotPaused onlyAgent {
        uint256 totalValue = 0;
        for (uint256 i = 0; i < calls.length; i++) {
            totalValue += calls[i].value;
        }

        uint256 bal = deposits[wallet];
        if (bal < totalValue) revert InsufficientDeposit(bal, totalValue);

        deposits[wallet] -= totalValue;

        for (uint256 i = 0; i < calls.length; i++) {
            (,, uint256 net) = _collectFees(calls[i].value);
            (bool ok,) = calls[i].to.call{value: net}(calls[i].data);
            if (!ok) revert ExecutionFailed(i);
            emit Executed(wallet, calls[i].to, net, calls[i].data);
        }

        emit BatchExecuted(wallet, calls.length);
    }

    function executeSwap(
        address wallet,
        address swapRouter,
        bytes calldata swapCalldata,
        uint256 amount,
        address outputToken
    ) external nonReentrant whenNotPaused onlyAgent {
        uint256 bal = deposits[wallet];
        if (bal < amount) revert InsufficientDeposit(bal, amount);

        deposits[wallet] -= amount;

        (,, uint256 net) = _collectFees(amount);
        uint256 balanceBefore = IERC20(outputToken).balanceOf(address(this));

        (bool ok,) = swapRouter.call{value: net}(swapCalldata);
        if (!ok) revert ExecutionFailed(0);

        uint256 balanceAfter = IERC20(outputToken).balanceOf(address(this));
        uint256 outputAmount = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
        if (outputAmount > 0) {
            require(IERC20(outputToken).transfer(wallet, outputAmount), "token transfer failed");
            emit TokensForwarded(outputToken, wallet, outputAmount);
        }

        emit Executed(wallet, swapRouter, net, swapCalldata);
    }

    function recordSpend(address wallet, uint256 feeWei) external onlyAgent {
        SessionPermission storage s = sessions[wallet];
        if (block.timestamp >= s.expiresAt) revert SessionExpired();
        if (feeWei > s.maxFeePerTxWei) revert FeeLimitExceeded();
        if (s.spentWei + feeWei > s.maxTotalSpendWei) revert BudgetExceeded();

        s.spentWei += feeWei;
        emit SpendRecorded(wallet, feeWei, s.spentWei);
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function emergencyWithdraw(address to) external onlyAgent {
        uint256 bal = address(this).balance;
        (bool ok,) = to.call{value: bal}("");
        require(ok, "transfer failed");
        emit EmergencyWithdrawn(to, bal);
    }

    function rescueERC20(address token, address to, uint256 amount) external onlyAgent {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        require(IERC20(token).transfer(to, amount), "token transfer failed");
        emit TokensRescued(token, to, amount);
    }

    function pause() external onlyAgent {
        _pause();
    }

    function unpause() external onlyAgent {
        _unpause();
    }

    // ── View functions ────────────────────────────────────────────────────────

    function canExecute(address wallet, uint256 feeWei) public view returns (bool) {
        SessionPermission storage s = sessions[wallet];
        return block.timestamp < s.expiresAt
            && feeWei <= s.maxFeePerTxWei
            && s.spentWei + feeWei <= s.maxTotalSpendWei;
    }

    function canExecuteWithDeposit(
        address wallet,
        uint256 feeWei,
        uint256 intentAmount
    ) external view returns (bool) {
        return canExecute(wallet, feeWei) && deposits[wallet] >= intentAmount;
    }

    function remainingBudget(address wallet) external view returns (uint256) {
        SessionPermission storage s = sessions[wallet];
        if (block.timestamp >= s.expiresAt) return 0;
        return s.maxTotalSpendWei - s.spentWei;
    }

    function remainingDeposit(address wallet) external view returns (uint256) {
        return deposits[wallet];
    }

    function feeForAmount(uint256 value) public view returns (uint256) {
        return (value * feeBps) / 10000;
    }

    function netAfterFee(uint256 value) public view returns (uint256) {
        return value - feeForAmount(value);
    }

    function agentFeeForAmount(uint256 value) public view returns (uint256) {
        return (feeForAmount(value) * agentFeeSplit) / 100;
    }

    function treasuryFeeForAmount(uint256 value) public view returns (uint256) {
        return feeForAmount(value) - agentFeeForAmount(value);
    }

    function isDelegated(address wallet) external view returns (bool) {
        bytes memory code = wallet.code;
        if (code.length < 23) return false;
        return code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00;
    }

    // ── Receive / fallback ────────────────────────────────────────────────────

    receive() external payable {
        deposits[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    fallback() external payable {}

    // ── Internal ──────────────────────────────────────────────────────────────

    function _collectFees(uint256 grossAmount)
        internal
        returns (uint256 totalFee, uint256 agentFee, uint256 netAmount)
    {
        totalFee = feeForAmount(grossAmount);
        agentFee = agentFeeForAmount(grossAmount);
        uint256 treasuryFee = totalFee - agentFee;
        netAmount = grossAmount - totalFee;

        if (agentFee > 0) {
            (bool ok,) = agentAddress.call{value: agentFee}("");
            if (!ok) {
                emit FeeCollectionFailed(agentAddress, agentFee);
            } else {
                emit FeeCollected(agentAddress, agentFee, grossAmount, "agent");
            }
        }

        if (treasuryFee > 0) {
            (bool ok,) = treasury.call{value: treasuryFee}("");
            if (!ok) {
                emit FeeCollectionFailed(treasury, treasuryFee);
            } else {
                emit FeeCollected(treasury, treasuryFee, grossAmount, "treasury");
            }
        }
    }
}
