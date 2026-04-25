// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/WhenCheapSession.sol";

contract WhenCheapSessionTest is Test {
    WhenCheapSession private session;
    address private wallet = address(0xA11CE);

    function setUp() public {
        session = new WhenCheapSession();
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
}
