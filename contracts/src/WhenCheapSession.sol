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

    event SessionUpdated(
        address indexed wallet,
        uint256 maxFeePerTxWei,
        uint256 maxTotalSpendWei,
        uint256 expiresAt
    );
    event SpendRecorded(address indexed wallet, uint256 feeWei, uint256 totalSpentWei);
    event SessionRevoked(address indexed wallet);

    error SessionExpired();
    error FeeLimitExceeded();
    error TotalSpendExceeded();

    function updateSession(
        uint256 maxFeePerTxWei,
        uint256 maxTotalSpendWei,
        uint256 expiresAt,
        address[] calldata allowedTokens
    ) external {
        sessions[msg.sender] = SessionPermission({
            maxFeePerTxWei: maxFeePerTxWei,
            maxTotalSpendWei: maxTotalSpendWei,
            spentWei: 0,
            expiresAt: expiresAt,
            allowedTokens: allowedTokens
        });

        emit SessionUpdated(msg.sender, maxFeePerTxWei, maxTotalSpendWei, expiresAt);
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

    function recordSpend(uint256 feeWei) external {
        SessionPermission storage session = sessions[msg.sender];

        if (block.timestamp >= session.expiresAt) revert SessionExpired();
        if (feeWei > session.maxFeePerTxWei) revert FeeLimitExceeded();
        if (session.spentWei + feeWei > session.maxTotalSpendWei) revert TotalSpendExceeded();

        session.spentWei += feeWei;
        emit SpendRecorded(msg.sender, feeWei, session.spentWei);
    }
}
