// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/WhenCheapSession.sol";

contract MockUniversalRouter {
    bytes public lastCommands;
    bytes[] public lastInputs;
    uint256 public lastDeadline;
    uint256 public lastValue;

    function execute(
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 deadline
    ) external payable {
        lastCommands = commands;
        delete lastInputs;
        for (uint256 i = 0; i < inputs.length; i++) {
            lastInputs.push(inputs[i]);
        }
        lastDeadline = deadline;
        lastValue = msg.value;
    }
}

contract MockERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount)
        external
        returns (bool)
    {
        require(balanceOf[from] >= amount, "insufficient");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }
}

contract BatchReceiver {
    uint256 public count;

    function increment() external payable {
        count += 1;
    }
}

contract BatchReverter {
    function fail() external pure {
        revert("fail");
    }
}

contract WhenCheapSessionTest is Test {
    WhenCheapSession private session;
    WhenCheapSession private zeroFeeSession;
    MockUniversalRouter private universalRouter;
    MockERC20 private token;
    BatchReceiver private receiver;
    BatchReverter private reverter;

    address private wallet = address(0xA11CE);
    address private agent = address(0xA6E17);
    address private treasury = address(0x7EAA5);
    address private recipient = address(0xBEEF);

    function setUp() public {
        universalRouter = new MockUniversalRouter();
        token = new MockERC20();
        session = new WhenCheapSession(
            agent,
            treasury,
            30,
            50,
            address(universalRouter)
        );
        zeroFeeSession = new WhenCheapSession(
            agent,
            treasury,
            0,
            50,
            address(universalRouter)
        );
        receiver = new BatchReceiver();
        reverter = new BatchReverter();
    }

    function _authorizeDefaultSession() internal {
        vm.prank(wallet);
        session.authorize(1 ether, 3 ether, 1 hours);
    }

    function testAuthorizeWithValidParams() public {
        _authorizeDefaultSession();

        (uint256 maxFeePerTxWei, uint256 maxTotalSpendWei, uint256 spentWei, uint256 expiresAt) =
            session.sessions(wallet);

        assertEq(maxFeePerTxWei, 1 ether);
        assertEq(maxTotalSpendWei, 3 ether);
        assertEq(spentWei, 0);
        assertEq(expiresAt, block.timestamp + 1 hours);
    }

    function testAuthorizeRevertsOnZeroDuration() public {
        vm.expectRevert(WhenCheapSession.InvalidDuration.selector);
        vm.prank(wallet);
        session.authorize(1 ether, 3 ether, 0);
    }

    function testAuthorizeRevertsWhenMaxFeeExceedsBudget() public {
        vm.expectRevert(WhenCheapSession.FeeLimitExceeded.selector);
        vm.prank(wallet);
        session.authorize(4 ether, 3 ether, 1 hours);
    }

    function testConstructorRevertsWhenFeeTooHigh() public {
        vm.expectRevert(WhenCheapSession.InvalidFee.selector);
        new WhenCheapSession(agent, treasury, 1001, 50, address(universalRouter));
    }

    function testConstructorRevertsWhenAgentSplitTooHigh() public {
        vm.expectRevert(WhenCheapSession.InvalidFee.selector);
        new WhenCheapSession(agent, treasury, 30, 101, address(universalRouter));
    }

    function testCanExecuteReturnsFalseAfterExpiry() public {
        _authorizeDefaultSession();
        vm.warp(block.timestamp + 2 hours);
        assertFalse(session.canExecute(wallet, 0.5 ether));
    }

    function testExecuteRevertsIfCallerIsNotAgent() public {
        vm.expectRevert(WhenCheapSession.OnlyAgent.selector);
        vm.prank(wallet);
        session.execute(recipient, 0.1 ether, "");
    }

    function testExecuteRevertsIfMsgValueIsLessThanValue() public {
        vm.deal(agent, 1 ether);

        vm.expectRevert(WhenCheapSession.InsufficientValue.selector);
        vm.prank(agent);
        session.execute{value: 0.05 ether}(recipient, 0.1 ether, "");
    }

    function testExecuteSendsCorrectFeeToTreasury() public {
        vm.deal(agent, 1 ether);

        uint256 treasuryBefore = treasury.balance;
        vm.prank(agent);
        session.execute{value: 1 ether}(recipient, 1 ether, "");

        assertEq(treasury.balance - treasuryBefore, 0.0015 ether);
    }

    function testExecuteSendsCorrectFeeToAgent() public {
        vm.deal(agent, 2 ether);

        uint256 agentBefore = agent.balance;
        vm.prank(agent);
        session.execute{value: 1 ether}(recipient, 1 ether, "");

        assertEq(agent.balance, agentBefore - 1 ether + 0.0015 ether);
    }

    function testExecuteSendsNetAmountToRecipient() public {
        vm.deal(agent, 1 ether);

        uint256 recipientBefore = recipient.balance;
        vm.prank(agent);
        session.execute{value: 1 ether}(recipient, 1 ether, "");

        assertEq(recipient.balance - recipientBefore, 0.997 ether);
    }

    function testFeeForAmountReturnsExpectedValue() public view {
        assertEq(session.feeForAmount(1 ether), 0.003 ether);
    }

    function testSwapFeeForAmountReturnsExpectedValue() public view {
        assertEq(session.swapFeeForAmount(1 ether), 0.003 ether);
    }

    function testNetSwapAmountReturnsExpectedValue() public view {
        assertEq(session.netSwapAmount(1 ether), 0.997 ether);
    }

    function testAgentFeeForAmountReturnsExpectedValue() public view {
        assertEq(session.agentFeeForAmount(1 ether), 0.0015 ether);
    }

    function testTreasuryFeeForAmountReturnsExpectedValue() public view {
        assertEq(session.treasuryFeeForAmount(1 ether), 0.0015 ether);
    }

    function testNetAfterFeeReturnsExpectedValue() public view {
        assertEq(session.netAfterFee(1 ether), 0.997 ether);
    }

    function testExecuteEmitsFeeCollectedEvents() public {
        vm.deal(agent, 1 ether);

        vm.expectEmit(true, false, false, true);
        emit WhenCheapSession.FeeCollected(agent, 0.0015 ether, 1 ether, "agent");
        vm.expectEmit(true, false, false, true);
        emit WhenCheapSession.FeeCollected(treasury, 0.0015 ether, 1 ether, "treasury");

        vm.prank(agent);
        session.execute{value: 1 ether}(recipient, 1 ether, "");
    }

    function testExecuteWorksWithZeroFee() public {
        vm.deal(agent, 1 ether);

        uint256 recipientBefore = recipient.balance;
        uint256 treasuryBefore = treasury.balance;

        vm.prank(agent);
        zeroFeeSession.execute{value: 1 ether}(recipient, 1 ether, "");

        assertEq(recipient.balance - recipientBefore, 1 ether);
        assertEq(treasury.balance - treasuryBefore, 0);
    }

    function testExecuteBatchExecutesAllCallsAtomically() public {
        vm.deal(agent, 1 ether);

        WhenCheapSession.Call[] memory calls = new WhenCheapSession.Call[](2);
        calls[0] = WhenCheapSession.Call({
            to: address(receiver),
            value: 0.1 ether,
            data: abi.encodeCall(BatchReceiver.increment, ())
        });
        calls[1] = WhenCheapSession.Call({
            to: address(receiver),
            value: 0,
            data: abi.encodeCall(BatchReceiver.increment, ())
        });

        uint256 treasuryBefore = treasury.balance;
        vm.prank(agent);
        session.executeBatch{value: 0.1 ether}(calls);

        assertEq(receiver.count(), 2);
        assertEq(treasury.balance - treasuryBefore, 0.00015 ether);
    }

    function testExecuteBatchRevertsEntireBatchOnSingleFailure() public {
        vm.deal(agent, 1 ether);

        WhenCheapSession.Call[] memory calls = new WhenCheapSession.Call[](3);
        calls[0] = WhenCheapSession.Call({
            to: address(receiver),
            value: 0.1 ether,
            data: abi.encodeCall(BatchReceiver.increment, ())
        });
        calls[1] = WhenCheapSession.Call({
            to: address(reverter),
            value: 0,
            data: abi.encodeCall(BatchReverter.fail, ())
        });
        calls[2] = WhenCheapSession.Call({
            to: address(receiver),
            value: 0,
            data: abi.encodeCall(BatchReceiver.increment, ())
        });

        uint256 treasuryBefore = treasury.balance;

        vm.expectRevert(abi.encodeWithSelector(WhenCheapSession.ExecutionFailed.selector, 1));
        vm.prank(agent);
        session.executeBatch{value: 0.1 ether}(calls);

        assertEq(receiver.count(), 0);
        assertEq(treasury.balance - treasuryBefore, 0);
    }

    function testSwapExecutesUniversalRouterAndCollectsFee() public {
        vm.deal(agent, 2 ether);

        bytes[] memory inputs = new bytes[](2);
        inputs[0] = hex"1111";
        inputs[1] = hex"2222";
        uint256 deadline = block.timestamp + 30 minutes;

        uint256 treasuryBefore = treasury.balance;
        uint256 agentBefore = agent.balance;

        vm.expectEmit(true, true, false, true);
        emit WhenCheapSession.SwapExecuted(
            address(session),
            address(universalRouter),
            1 ether,
            0.003 ether,
            0.997 ether
        );

        vm.prank(agent);
        session.swap{value: 1 ether}(hex"0b00", inputs, deadline, 1 ether);

        assertEq(universalRouter.lastValue(), 0.997 ether);
        assertEq(universalRouter.lastDeadline(), deadline);
        assertEq(universalRouter.lastCommands(), hex"0b00");
        assertEq(keccak256(universalRouter.lastInputs(0)), keccak256(inputs[0]));
        assertEq(keccak256(universalRouter.lastInputs(1)), keccak256(inputs[1]));
        assertEq(treasury.balance - treasuryBefore, 0.0015 ether);
        assertEq(agent.balance, agentBefore - 1 ether + 0.0015 ether);
    }

    function testSwapRevertsDeadlinePassed() public {
        vm.deal(agent, 1 ether);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = hex"1234";

        vm.expectRevert(WhenCheapSession.DeadlinePassed.selector);
        vm.prank(agent);
        session.swap{value: 1 ether}(hex"0b00", inputs, block.timestamp - 1, 1 ether);
    }

    function testSwapRevertsOnlyAgent() public {
        vm.deal(wallet, 1 ether);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = hex"1234";

        vm.expectRevert(WhenCheapSession.OnlyAgent.selector);
        vm.prank(wallet);
        session.swap{value: 1 ether}(hex"0b00", inputs, block.timestamp + 1, 1 ether);
    }

    function testSwapRevertsInsufficientValue() public {
        vm.deal(agent, 1 ether);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = hex"1234";

        vm.expectRevert(WhenCheapSession.InsufficientValue.selector);
        vm.prank(agent);
        session.swap{value: 0.5 ether}(hex"0b00", inputs, block.timestamp + 1, 1 ether);
    }

    function testSwapTokenTransfersTokenToRouter() public {
        token.mint(address(session), 5 ether);

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = hex"abcd";
        uint256 deadline = block.timestamp + 30 minutes;

        vm.prank(agent);
        session.swapToken(address(token), 1 ether, hex"00", inputs, deadline);

        assertEq(token.balanceOf(address(universalRouter)), 1 ether);
        assertEq(universalRouter.lastDeadline(), deadline);
        assertEq(universalRouter.lastValue(), 0);
        assertEq(universalRouter.lastCommands(), hex"00");
    }

    function testRecordSpendCorrectlyDebitsSession() public {
        _authorizeDefaultSession();

        vm.prank(agent);
        session.recordSpend(wallet, 0.5 ether);

        (,, uint256 spentWei,) = session.sessions(wallet);
        assertEq(spentWei, 0.5 ether);
    }

    function testRecordSpendRevertsWhenBudgetExceeded() public {
        vm.prank(wallet);
        session.authorize(2 ether, 3 ether, 1 hours);

        vm.prank(agent);
        session.recordSpend(wallet, 2 ether);

        vm.expectRevert(WhenCheapSession.BudgetExceeded.selector);
        vm.prank(agent);
        session.recordSpend(wallet, 2 ether);
    }

    function testRemainingBudgetReturnsCorrectValue() public {
        _authorizeDefaultSession();

        vm.prank(agent);
        session.recordSpend(wallet, 0.75 ether);

        assertEq(session.remainingBudget(wallet), 2.25 ether);
    }

    function testPauseAndUnpauseBlocksExecution() public {
        vm.deal(agent, 1 ether);

        vm.prank(agent);
        session.pause();

        vm.expectRevert();
        vm.prank(agent);
        session.execute{value: 0.1 ether}(recipient, 0.1 ether, "");

        vm.prank(agent);
        session.unpause();

        uint256 beforeBalance = recipient.balance;

        vm.prank(agent);
        session.execute{value: 0.1 ether}(recipient, 0.1 ether, "");

        assertEq(recipient.balance, beforeBalance + 0.0997 ether);
    }

    function testIsDelegatedReturnsCorrectValue() public {
        address delegatedWallet = address(0xD1E6);
        bytes memory delegatedCode = abi.encodePacked(bytes3(0xef0100), bytes20(address(session)));

        vm.etch(delegatedWallet, delegatedCode);

        assertTrue(session.isDelegated(delegatedWallet));
        assertFalse(session.isDelegated(wallet));
    }
}
