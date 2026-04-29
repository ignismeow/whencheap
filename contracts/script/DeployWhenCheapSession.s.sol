// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/WhenCheapSession.sol";

contract DeployWhenCheapSession is Script {
    function run() external returns (WhenCheapSession deployed) {
        address agentAddress = vm.envAddress("AGENT_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        uint16 feeBps = uint16(vm.envUint("FEE_BPS"));
        uint16 agentFeeSplit = uint16(vm.envUint("AGENT_FEE_SPLIT"));
        address universalRouter = vm.envAddress("UNIVERSAL_ROUTER");
        vm.startBroadcast();
        deployed = new WhenCheapSession(
            agentAddress,
            treasury,
            feeBps,
            agentFeeSplit,
            universalRouter
        );
        vm.stopBroadcast();
    }
}
