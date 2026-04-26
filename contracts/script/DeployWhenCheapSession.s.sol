// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/WhenCheapSession.sol";

contract DeployWhenCheapSession is Script {
    function run() external returns (WhenCheapSession deployed) {
        address agentAddress = vm.envAddress("AGENT_ADDRESS");
        vm.startBroadcast();
        deployed = new WhenCheapSession(agentAddress);
        vm.stopBroadcast();
    }
}
