// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/WhenCheapSession.sol";

contract Deploy is Script {
    function run() external returns (WhenCheapSession deployed) {
        address agentAddress  = vm.envAddress("AGENT_ADDRESS");
        address treasuryAddr  = vm.envAddress("TREASURY_ADDRESS");
        uint16  feeBps        = uint16(vm.envOr("FEE_BPS", uint256(30)));
        uint16  agentFeeSplit = uint16(vm.envOr("AGENT_FEE_SPLIT", uint256(50)));

        vm.startBroadcast();
        deployed = new WhenCheapSession(agentAddress, treasuryAddr, feeBps, agentFeeSplit);
        vm.stopBroadcast();

        console2.log("WhenCheapSession deployed at:", address(deployed));
        console2.log("  agentAddress  :", agentAddress);
        console2.log("  treasury      :", treasuryAddr);
        console2.log("  feeBps        :", feeBps);
        console2.log("  agentFeeSplit :", agentFeeSplit);
    }
}
