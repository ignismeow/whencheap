// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/WhenCheapSession.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable tokenDecimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        tokenDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return tokenDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockSwapRouter {
    uint256 public lastValue;
    bytes public lastCalldata;
    address public lastSender;
    MockERC20 public immutable outputToken;

    constructor(MockERC20 _outputToken) {
        outputToken = _outputToken;
    }

    receive() external payable {}

    fallback() external payable {
        lastValue = msg.value;
        lastCalldata = msg.data;
        lastSender = msg.sender;
    }

    function swap() external payable {
        lastValue = msg.value;
        lastCalldata = msg.data;
        lastSender = msg.sender;
        outputToken.mint(msg.sender, 1000e6);
    }
}

contract ReentrantAttacker {
    WhenCheapSession public target;
    uint256 public attackCount;

    constructor(WhenCheapSession _target) {
        target = _target;
    }

    // Remove balance check — balance is already 0 mid-transfer in EVM
    receive() external payable {
        if (attackCount < 3) {
            attackCount++;
            target.withdraw(1 ether);
        }
    }

    function attack() external {
        target.deposit{value: 1 ether}();
        target.withdraw(1 ether);
    }
}

contract WhenCheapSessionTest is Test {
    WhenCheapSession public session;
    MockSwapRouter public swapRouter;
    MockERC20 public outputToken;

    address public agent = makeAddr("agent");
    address public treasury = makeAddr("treasury");
    address public user = makeAddr("user");
    address public user2 = makeAddr("user2");
    address public recipient = makeAddr("recipient");

    uint16 constant FEE_BPS = 30;        // 0.3%
    uint16 constant AGENT_FEE_SPLIT = 50; // 50% of fee to agent

    function setUp() public {
        session = new WhenCheapSession(agent, treasury, FEE_BPS, AGENT_FEE_SPLIT);
        outputToken = new MockERC20("Mock USDC", "mUSDC", 6);
        swapRouter = new MockSwapRouter(outputToken);

        vm.deal(user, 10 ether);
        vm.deal(user2, 10 ether);
        vm.deal(agent, 1 ether);
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    function test_constructor_revertsZeroAgent() public {
        vm.expectRevert(WhenCheapSession.ZeroAddress.selector);
        new WhenCheapSession(address(0), treasury, FEE_BPS, AGENT_FEE_SPLIT);
    }

    function test_constructor_revertsZeroTreasury() public {
        vm.expectRevert(WhenCheapSession.ZeroAddress.selector);
        new WhenCheapSession(agent, address(0), FEE_BPS, AGENT_FEE_SPLIT);
    }

    function test_constructor_revertsFeeTooHigh() public {
        vm.expectRevert(WhenCheapSession.InvalidFee.selector);
        new WhenCheapSession(agent, treasury, 1001, AGENT_FEE_SPLIT);
    }

    function test_constructor_revertsAgentFeeSplitTooHigh() public {
        vm.expectRevert(WhenCheapSession.InvalidFee.selector);
        new WhenCheapSession(agent, treasury, FEE_BPS, 101);
    }

    // ── Deposit ───────────────────────────────────────────────────────────────

    function test_deposit_happyPath() public {
        vm.prank(user);
        vm.expectEmit(true, false, false, true);
        emit WhenCheapSession.Deposited(user, 1 ether);
        session.deposit{value: 1 ether}();

        assertEq(session.deposits(user), 1 ether);
        assertEq(address(session).balance, 1 ether);
    }

    function test_deposit_revertsOnZero() public {
        vm.prank(user);
        vm.expectRevert("zero deposit");
        session.deposit{value: 0}();
    }

    function test_deposit_accumulatesMultiple() public {
        vm.startPrank(user);
        session.deposit{value: 1 ether}();
        session.deposit{value: 0.5 ether}();
        vm.stopPrank();

        assertEq(session.deposits(user), 1.5 ether);
    }

    function test_receive_creditsDeposit() public {
        vm.prank(user);
        (bool ok,) = address(session).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(session.deposits(user), 1 ether);
    }

    // ── Withdraw ──────────────────────────────────────────────────────────────

    function test_withdraw_happyPath() public {
        vm.startPrank(user);
        session.deposit{value: 2 ether}();

        uint256 balBefore = user.balance;
        vm.expectEmit(true, false, false, true);
        emit WhenCheapSession.Withdrawn(user, 1 ether);
        session.withdraw(1 ether);
        vm.stopPrank();

        assertEq(session.deposits(user), 1 ether);
        assertEq(user.balance, balBefore + 1 ether);
    }

    function test_withdraw_revertsInsufficientBalance() public {
        vm.prank(user);
        session.deposit{value: 0.5 ether}();

        vm.prank(user);
        vm.expectRevert("insufficient deposit");
        session.withdraw(1 ether);
    }

    function test_withdraw_full() public {
        vm.startPrank(user);
        session.deposit{value: 1 ether}();
        session.withdraw(1 ether);
        vm.stopPrank();

        assertEq(session.deposits(user), 0);
        assertEq(address(session).balance, 0);
    }

    // ── Authorize ─────────────────────────────────────────────────────────────

    function test_authorize_createsSession() public {
        vm.prank(user);
        vm.expectEmit(true, false, false, false);
        emit WhenCheapSession.SessionAuthorized(user, 0.01 ether, 0.1 ether, 0);
        session.authorize(0.01 ether, 0.1 ether, 86400);

        (uint256 maxFee, uint256 maxSpend, uint256 spent, uint256 expiresAt) = session.sessions(user);
        assertEq(maxFee, 0.01 ether);
        assertEq(maxSpend, 0.1 ether);
        assertEq(spent, 0);
        assertGt(expiresAt, block.timestamp);
    }

    function test_authorize_resetsSpentWei() public {
        vm.startPrank(user);
        session.authorize(0.01 ether, 0.1 ether, 86400);
        vm.stopPrank();

        vm.prank(agent);
        session.recordSpend(user, 0.005 ether);

        (,, uint256 spentBefore,) = session.sessions(user);
        assertEq(spentBefore, 0.005 ether);

        vm.prank(user);
        session.authorize(0.01 ether, 0.1 ether, 86400);

        (,, uint256 spentAfter,) = session.sessions(user);
        assertEq(spentAfter, 0);
    }

    function test_authorize_revertsZeroDuration() public {
        vm.prank(user);
        vm.expectRevert(WhenCheapSession.InvalidDuration.selector);
        session.authorize(0.01 ether, 0.1 ether, 0);
    }

    function test_authorize_revertsFeeLimitExceeded() public {
        vm.prank(user);
        vm.expectRevert(WhenCheapSession.FeeLimitExceeded.selector);
        session.authorize(0.2 ether, 0.1 ether, 86400); // maxFee > maxSpend
    }

    // ── RevokeSession ─────────────────────────────────────────────────────────

    function test_revokeSession_refundsDeposit() public {
        vm.startPrank(user);
        session.deposit{value: 1 ether}();
        session.authorize(0.01 ether, 0.1 ether, 86400);

        uint256 balBefore = user.balance;
        session.revokeSession();
        vm.stopPrank();

        (,,, uint256 expiresAt) = session.sessions(user);
        assertEq(expiresAt, 0);
        assertEq(session.deposits(user), 0);
        assertEq(user.balance, balBefore + 1 ether);
    }

    function test_revokeSession_noDepositNoRefund() public {
        vm.startPrank(user);
        session.authorize(0.01 ether, 0.1 ether, 86400);
        uint256 balBefore = user.balance;
        session.revokeSession();
        vm.stopPrank();

        assertEq(user.balance, balBefore);
    }

    function test_revokeSession_emitsCorrectEvents() public {
        vm.startPrank(user);
        session.deposit{value: 0.5 ether}();
        session.authorize(0.01 ether, 0.1 ether, 86400);

        vm.expectEmit(true, false, false, true);
        emit WhenCheapSession.Withdrawn(user, 0.5 ether);
        vm.expectEmit(true, false, false, true);
        emit WhenCheapSession.SessionRevoked(user, 0.5 ether);
        session.revokeSession();
        vm.stopPrank();
    }

    // ── Execute ───────────────────────────────────────────────────────────────

    function test_execute_deductsAndForwardsNet() public {
        vm.prank(user);
        session.deposit{value: 1 ether}();
        vm.prank(user);
        session.authorize(0.01 ether, 0.1 ether, 86400);

        uint256 recipientBefore = recipient.balance;
        uint256 agentBefore = agent.balance;
        uint256 treasuryBefore = treasury.balance;

        vm.prank(agent);
        session.execute(user, recipient, 0.1 ether, "");

        uint256 fee = (0.1 ether * FEE_BPS) / 10000; // 0.0003 ETH
        uint256 agentFee = (fee * AGENT_FEE_SPLIT) / 100;
        uint256 treasuryFee = fee - agentFee;
        uint256 net = 0.1 ether - fee;

        assertEq(recipient.balance, recipientBefore + net);
        assertEq(agent.balance, agentBefore + agentFee);
        assertEq(treasury.balance, treasuryBefore + treasuryFee);
        assertEq(session.deposits(user), 0.9 ether);
    }

    function test_execute_revertsInsufficientDeposit() public {
        vm.prank(user);
        session.deposit{value: 0.05 ether}();

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(WhenCheapSession.InsufficientDeposit.selector, 0.05 ether, 0.1 ether)
        );
        session.execute(user, recipient, 0.1 ether, "");
    }

    function test_execute_revertsIfNotAgent() public {
        vm.prank(user);
        session.deposit{value: 1 ether}();

        vm.prank(user);
        vm.expectRevert(WhenCheapSession.OnlyAgent.selector);
        session.execute(user, recipient, 0.1 ether, "");
    }

    function test_execute_revertsWhenPaused() public {
        vm.prank(user);
        session.deposit{value: 1 ether}();

        vm.prank(agent);
        session.pause();

        vm.prank(agent);
        vm.expectRevert();
        session.execute(user, recipient, 0.1 ether, "");
    }

    // ── ExecuteBatch ──────────────────────────────────────────────────────────

    function test_executeBatch_deductsAndForwardsAll() public {
        vm.prank(user);
        session.deposit{value: 2 ether}();

        address recipient2 = makeAddr("recipient2");

        WhenCheapSession.Call[] memory calls = new WhenCheapSession.Call[](2);
        calls[0] = WhenCheapSession.Call({to: recipient, value: 0.3 ether, data: ""});
        calls[1] = WhenCheapSession.Call({to: recipient2, value: 0.2 ether, data: ""});

        vm.prank(agent);
        session.executeBatch(user, calls);

        assertEq(session.deposits(user), 1.5 ether);

        uint256 fee1 = (0.3 ether * FEE_BPS) / 10000;
        uint256 fee2 = (0.2 ether * FEE_BPS) / 10000;
        assertEq(recipient.balance, 0.3 ether - fee1);
        assertEq(recipient2.balance, 0.2 ether - fee2);
    }

    function test_executeBatch_revertsInsufficientDeposit() public {
        vm.prank(user);
        session.deposit{value: 0.4 ether}();

        WhenCheapSession.Call[] memory calls = new WhenCheapSession.Call[](2);
        calls[0] = WhenCheapSession.Call({to: recipient, value: 0.3 ether, data: ""});
        calls[1] = WhenCheapSession.Call({to: recipient, value: 0.2 ether, data: ""});

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(WhenCheapSession.InsufficientDeposit.selector, 0.4 ether, 0.5 ether)
        );
        session.executeBatch(user, calls);
    }

    // ── ExecuteSwap ───────────────────────────────────────────────────────────

    function test_executeSwap_deductsAndRoutes() public {
        vm.prank(user);
        session.deposit{value: 1 ether}();

        vm.prank(agent);
        session.executeSwap(user, address(swapRouter), hex"deadbeef", 0.5 ether, address(outputToken));

        uint256 fee = (0.5 ether * FEE_BPS) / 10000;
        assertEq(swapRouter.lastValue(), 0.5 ether - fee);
        assertEq(session.deposits(user), 0.5 ether);
    }

    function test_executeSwap_forwardsOutputTokensToUser() public {
        vm.prank(user);
        session.deposit{value: 1 ether}();

        bytes memory swapCalldata = abi.encodeWithSignature("swap()");

        vm.prank(agent);
        session.executeSwap(
            user,
            address(swapRouter),
            swapCalldata,
            0.5 ether,
            address(outputToken)
        );

        assertEq(outputToken.balanceOf(user), 1000e6);
        assertEq(outputToken.balanceOf(address(session)), 0);
        assertEq(swapRouter.lastSender(), address(session));
    }

    function test_executeSwap_revertsInsufficientDeposit() public {
        vm.prank(user);
        session.deposit{value: 0.1 ether}();

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(WhenCheapSession.InsufficientDeposit.selector, 0.1 ether, 0.5 ether)
        );
        session.executeSwap(user, address(swapRouter), hex"deadbeef", 0.5 ether, address(outputToken));
    }

    // ── RecordSpend ───────────────────────────────────────────────────────────

    function test_recordSpend_incrementsSpent() public {
        vm.prank(user);
        session.authorize(0.01 ether, 0.1 ether, 86400);

        vm.prank(agent);
        session.recordSpend(user, 0.005 ether);

        (,, uint256 spent,) = session.sessions(user);
        assertEq(spent, 0.005 ether);
    }

    function test_recordSpend_revertsExpiredSession() public {
        vm.prank(user);
        session.authorize(0.01 ether, 0.1 ether, 1);

        skip(2);

        vm.prank(agent);
        vm.expectRevert(WhenCheapSession.SessionExpired.selector);
        session.recordSpend(user, 0.001 ether);
    }

    function test_recordSpend_revertsFeeLimitExceeded() public {
        vm.prank(user);
        session.authorize(0.01 ether, 0.1 ether, 86400);

        vm.prank(agent);
        vm.expectRevert(WhenCheapSession.FeeLimitExceeded.selector);
        session.recordSpend(user, 0.02 ether);
    }

    function test_recordSpend_revertsBudgetExceeded() public {
        // maxFeePerTxWei must be >= both spend amounts so FeeLimitExceeded doesn't fire first
        vm.prank(user);
        session.authorize(0.1 ether, 0.1 ether, 86400);

        vm.prank(agent);
        session.recordSpend(user, 0.05 ether); // spentWei = 0.05

        vm.prank(agent);
        vm.expectRevert(WhenCheapSession.BudgetExceeded.selector);
        session.recordSpend(user, 0.06 ether); // 0.05 + 0.06 > 0.1 → BudgetExceeded
    }

    // ── View functions ────────────────────────────────────────────────────────

    function test_canExecute_returnsTrue() public {
        vm.prank(user);
        session.authorize(0.01 ether, 0.1 ether, 86400);

        assertTrue(session.canExecute(user, 0.005 ether));
    }

    function test_canExecute_returnsFalseExpired() public {
        vm.prank(user);
        session.authorize(0.01 ether, 0.1 ether, 1);
        skip(2);

        assertFalse(session.canExecute(user, 0.005 ether));
    }

    function test_canExecuteWithDeposit_returnsCorrectBool() public {
        vm.startPrank(user);
        session.deposit{value: 0.5 ether}();
        session.authorize(0.01 ether, 0.1 ether, 86400);
        vm.stopPrank();

        assertTrue(session.canExecuteWithDeposit(user, 0.005 ether, 0.5 ether));
        assertFalse(session.canExecuteWithDeposit(user, 0.005 ether, 0.6 ether));
        assertFalse(session.canExecuteWithDeposit(user, 0.02 ether, 0.1 ether)); // fee > max
    }

    function test_remainingBudget_returnsZeroWhenExpired() public {
        vm.prank(user);
        session.authorize(0.01 ether, 0.1 ether, 1);
        skip(2);

        assertEq(session.remainingBudget(user), 0);
    }

    function test_remainingBudget_decreasesAfterSpend() public {
        vm.prank(user);
        session.authorize(0.05 ether, 0.1 ether, 86400); // maxFeePerTxWei = 0.05

        vm.prank(agent);
        session.recordSpend(user, 0.03 ether); // 0.03 <= 0.05 → OK

        assertEq(session.remainingBudget(user), 0.07 ether);
    }

    function test_remainingDeposit() public {
        vm.prank(user);
        session.deposit{value: 1 ether}();
        assertEq(session.remainingDeposit(user), 1 ether);
    }

    function test_rescueERC20_transfersTokens() public {
        outputToken.mint(address(session), 250e6);

        vm.prank(agent);
        session.rescueERC20(address(outputToken), user, 250e6);

        assertEq(outputToken.balanceOf(user), 250e6);
        assertEq(outputToken.balanceOf(address(session)), 0);
    }

    // ── Fee math ──────────────────────────────────────────────────────────────

    function test_feeForAmount() public view {
        // 1 ETH * 30 bps = 0.003 ETH
        assertEq(session.feeForAmount(1 ether), 0.003 ether);
    }

    function test_netAfterFee() public view {
        assertEq(session.netAfterFee(1 ether), 0.997 ether);
    }

    function test_agentFeeForAmount() public view {
        // 0.003 ETH fee, 50% to agent = 0.0015 ETH
        assertEq(session.agentFeeForAmount(1 ether), 0.0015 ether);
    }

    function test_treasuryFeeForAmount() public view {
        assertEq(session.treasuryFeeForAmount(1 ether), 0.0015 ether);
    }

    function test_feeForAmount_zeroOnZero() public view {
        assertEq(session.feeForAmount(0), 0);
    }

    // ── Reentrancy ────────────────────────────────────────────────────────────

    function test_withdraw_reentrancyBlocked() public {
        ReentrantAttacker attacker = new ReentrantAttacker(session);
        vm.deal(address(attacker), 2 ether);

        // attack() deposits 1 ETH then tries to withdraw; the reentrant withdraw
        // inside receive() is blocked by nonReentrant → ok=false → WithdrawFailed
        vm.expectRevert(WhenCheapSession.WithdrawFailed.selector);
        attacker.attack();

        // State is reverted: attacker gained nothing
        assertEq(session.deposits(address(attacker)), 0);
    }

    // ── EmergencyWithdraw ─────────────────────────────────────────────────────

    function test_emergencyWithdraw_drainsFunds() public {
        vm.prank(user);
        session.deposit{value: 5 ether}();

        address safe = makeAddr("safe");
        vm.prank(agent);
        session.emergencyWithdraw(safe);

        assertEq(address(session).balance, 0);
        assertEq(safe.balance, 5 ether);
    }

    function test_emergencyWithdraw_revertsIfNotAgent() public {
        vm.prank(user);
        session.deposit{value: 1 ether}();

        vm.prank(user);
        vm.expectRevert(WhenCheapSession.OnlyAgent.selector);
        session.emergencyWithdraw(user);
    }

    // ── Pause ─────────────────────────────────────────────────────────────────

    function test_pause_blocksExecute() public {
        vm.prank(user);
        session.deposit{value: 1 ether}();

        vm.prank(agent);
        session.pause();

        vm.prank(agent);
        vm.expectRevert();
        session.execute(user, recipient, 0.1 ether, "");
    }

    function test_unpause_restoresExecute() public {
        vm.prank(user);
        session.deposit{value: 1 ether}();

        vm.startPrank(agent);
        session.pause();
        session.unpause();
        session.execute(user, recipient, 0.1 ether, "");
        vm.stopPrank();

        assertLt(session.deposits(user), 1 ether);
    }

    function test_pause_revertsIfNotAgent() public {
        vm.prank(user);
        vm.expectRevert(WhenCheapSession.OnlyAgent.selector);
        session.pause();
    }
}
