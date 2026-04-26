// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/WhenCheapSession.sol";

contract WhenCheapSessionTest is Test {
    WhenCheapSession private session;
    address private wallet = address(0xA11CE);
    address private agent = address(0xA6E17);
    address private recipient = address(0xBEEF);

    function setUp() public {
        session = new WhenCheapSession(agent);
    }

    function testCanExecuteWithinLimits() public {
        vm.prank(wallet);
        session.updateSession(1 ether, 3 ether, block.timestamp + 1 hours, new address[](0));

        assertTrue(session.canExecute(wallet, 0.5 ether));
    }

    function testCannotExecuteAfterExpiry() public {
        vm.prank(wallet);
        session.updateSession(1 ether, 3 ether, block.timestamp + 1 hours, new address[](0));

        vm.warp(block.timestamp + 2 hours);

        assertFalse(session.canExecute(wallet, 0.5 ether));
    }

    function testOnlyAgentCanRecordSpend() public {
        vm.prank(wallet);
        session.updateSession(1 ether, 3 ether, block.timestamp + 1 hours, new address[](0));

        vm.expectRevert(WhenCheapSession.OnlyAgent.selector);
        vm.prank(address(0xB0B));
        session.recordSpend(wallet, 0.5 ether);
    }

    function testAgentCanRecordSpendForWallet() public {
        vm.prank(wallet);
        session.updateSession(1 ether, 3 ether, block.timestamp + 1 hours, new address[](0));

        vm.prank(agent);
        session.recordSpend(wallet, 0.5 ether);

        (,, uint256 spentWei,) = session.sessions(wallet);
        assertEq(spentWei, 0.5 ether);
    }

    function testOnlyAgentCanExecute() public {
        vm.prank(address(session));
        session.updateSession(1 ether, 3 ether, block.timestamp + 1 hours, new address[](0));

        vm.expectRevert(WhenCheapSession.OnlyAgent.selector);
        vm.prank(wallet);
        session.execute(recipient, 0.1 ether, "");
    }

    function testAgentCanExecuteFromDelegatedContext() public {
        vm.deal(address(session), 1 ether);
        vm.prank(address(session));
        session.updateSession(1 ether, 3 ether, block.timestamp + 1 hours, new address[](0));

        uint256 beforeBalance = recipient.balance;

        vm.prank(agent);
        session.execute(recipient, 0.1 ether, "");

        assertEq(recipient.balance, beforeBalance + 0.1 ether);
    }

    function testAgentCannotExecuteAfterExpiry() public {
        vm.deal(address(session), 1 ether);
        vm.prank(address(session));
        session.updateSession(1 ether, 3 ether, block.timestamp + 1 hours, new address[](0));

        vm.warp(block.timestamp + 2 hours);

        vm.expectRevert(WhenCheapSession.SessionExpired.selector);
        vm.prank(agent);
        session.execute(recipient, 0.1 ether, "");
    }
}
