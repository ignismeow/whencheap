// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract WhenCheapSession {
    struct SessionPermission {
        uint256 maxFeePerTxWei;
        uint256 maxTotalSpendWei;
        uint256 spentWei;
        uint256 expiresAt;
        address[] allowedTokens;
    }

    mapping(address wallet => SessionPermission permission) public sessions;
    address public agentAddress;

    event SessionUpdated(
        address indexed wallet,
        uint256 maxFeePerTxWei,
        uint256 maxTotalSpendWei,
        uint256 expiresAt
    );
    event SpendRecorded(address indexed wallet, uint256 feeWei, uint256 totalSpentWei);
    event SessionRevoked(address indexed wallet);
    event AgentUpdated(address indexed agentAddress);
    event Executed(address indexed wallet, address indexed to, uint256 value, bytes data);

    error SessionExpired();
    error FeeLimitExceeded();
    error TotalSpendExceeded();
    error OnlyAgent();
    error ExecutionFailed();

    constructor(address _agentAddress) {
        agentAddress = _agentAddress;
        emit AgentUpdated(_agentAddress);
    }

    function authorize(
        uint256 maxFeePerTxWei,
        uint256 maxTotalSpendWei,
        uint256 durationSeconds
    ) external {
        _setSession(
            msg.sender,
            maxFeePerTxWei,
            maxTotalSpendWei,
            block.timestamp + durationSeconds,
            new address[](0)
        );
    }

    function updateSession(
        uint256 maxFeePerTxWei,
        uint256 maxTotalSpendWei,
        uint256 expiresAt,
        address[] calldata allowedTokens
    ) external {
        _setSession(msg.sender, maxFeePerTxWei, maxTotalSpendWei, expiresAt, allowedTokens);
    }

    function revokeSession() external {
        delete sessions[msg.sender];
        emit SessionRevoked(msg.sender);
    }

    function canExecute(address wallet, uint256 feeWei) public view returns (bool) {
        SessionPermission storage session = sessions[wallet];
        return block.timestamp < session.expiresAt
            && feeWei <= session.maxFeePerTxWei
            && session.spentWei + feeWei <= session.maxTotalSpendWei;
    }

    function recordSpend(address wallet, uint256 feeWei) external {
        if (msg.sender != agentAddress) revert OnlyAgent();

        SessionPermission storage session = sessions[wallet];

        if (block.timestamp >= session.expiresAt) revert SessionExpired();
        if (feeWei > session.maxFeePerTxWei) revert FeeLimitExceeded();
        if (session.spentWei + feeWei > session.maxTotalSpendWei) revert TotalSpendExceeded();

        session.spentWei += feeWei;
        emit SpendRecorded(wallet, feeWei, session.spentWei);
    }

    function execute(address to, uint256 value, bytes calldata data) external {
        if (msg.sender != agentAddress) revert OnlyAgent();
        if (!canExecute(address(this), 0)) revert SessionExpired();

        (bool success,) = to.call{value: value}(data);
        if (!success) revert ExecutionFailed();

        emit Executed(address(this), to, value, data);
    }

    function _setSession(
        address wallet,
        uint256 maxFeePerTxWei,
        uint256 maxTotalSpendWei,
        uint256 expiresAt,
        address[] memory allowedTokens
    ) internal {
        sessions[wallet] = SessionPermission({
            maxFeePerTxWei: maxFeePerTxWei,
            maxTotalSpendWei: maxTotalSpendWei,
            spentWei: 0,
            expiresAt: expiresAt,
            allowedTokens: allowedTokens
        });

        emit SessionUpdated(wallet, maxFeePerTxWei, maxTotalSpendWei, expiresAt);
    }
}
