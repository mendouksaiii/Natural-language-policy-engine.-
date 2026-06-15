// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SentinelRegistry
 * @notice Append-only, tamper-evident audit log of every policy decision SENTINEL's
 *         AI makes for an autonomous agent — both APPROVALS and REJECTIONS.
 *
 * Why this matters: an off-chain AI policy engine can be silently edited or have its
 * logs rewritten. By committing a hash of (policy version, transaction parameters,
 * decision, reason) to Mantle on every evaluation, SENTINEL produces a public,
 * immutable, independently-verifiable history of how autonomous capital was governed.
 * Auditors can replay the natural-language policy against the recorded inputs and
 * confirm the AI behaved as committed.
 *
 * This is the reusable "policy audit trail" primitive other Mantle agent projects can
 * adopt — the long-term ecosystem contribution beyond SENTINEL itself.
 */
contract SentinelRegistry {
    enum Decision { REJECTED, APPROVED, AUTO_EXECUTED }

    struct Record {
        uint64 timestamp;
        Decision decision;
        address recipient;
        uint256 amount; // settlement-asset units (USDC 6dp) or wei for native
        bytes32 policyHash; // keccak256 of the active natural-language policy text
        bytes32 purposeHash; // keccak256 of the human purpose string
        bytes32 reasonHash; // keccak256 of the AI reason string (full text in event)
    }

    address public owner;
    mapping(address => bool) public writers; // authorized SENTINEL nodes

    Record[] public records;

    event DecisionLogged(
        uint256 indexed id,
        Decision indexed decision,
        address indexed recipient,
        uint256 amount,
        bytes32 policyHash,
        bytes32 purposeHash,
        string reason
    );
    event WriterSet(address indexed writer, bool allowed);

    modifier onlyOwner() {
        require(msg.sender == owner, "Registry: not owner");
        _;
    }

    modifier onlyWriter() {
        require(writers[msg.sender], "Registry: not writer");
        _;
    }

    constructor() {
        owner = msg.sender;
        writers[msg.sender] = true;
        emit WriterSet(msg.sender, true);
    }

    function setWriter(address writer, bool allowed) external onlyOwner {
        writers[writer] = allowed;
        emit WriterSet(writer, allowed);
    }

    function logDecision(
        Decision decision,
        address recipient,
        uint256 amount,
        bytes32 policyHash,
        bytes32 purposeHash,
        string calldata reason
    ) external onlyWriter returns (uint256 id) {
        id = records.length;
        records.push(
            Record({
                timestamp: uint64(block.timestamp),
                decision: decision,
                recipient: recipient,
                amount: amount,
                policyHash: policyHash,
                purposeHash: purposeHash,
                reasonHash: keccak256(bytes(reason))
            })
        );
        emit DecisionLogged(id, decision, recipient, amount, policyHash, purposeHash, reason);
    }

    function total() external view returns (uint256) {
        return records.length;
    }

    /// @notice Page through the audit log newest-first for dashboards/auditors.
    function getRecords(uint256 offset, uint256 limit)
        external
        view
        returns (Record[] memory page)
    {
        uint256 len = records.length;
        if (offset >= len) return new Record[](0);
        uint256 end = offset + limit;
        if (end > len) end = len;
        page = new Record[](end - offset);
        for (uint256 i = 0; i < page.length; i++) {
            page[i] = records[len - 1 - offset - i];
        }
    }
}
