// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ISentinelRegistry {
    enum Decision { REJECTED, APPROVED, AUTO_EXECUTED }
    function logDecision(
        Decision decision,
        address recipient,
        uint256 amount,
        bytes32 policyHash,
        bytes32 purposeHash,
        string calldata reason
    ) external returns (uint256);
}

/**
 * @title SentinelVault
 * @notice An autonomous agent's on-chain treasury on Mantle whose funds can ONLY move
 *         when accompanied by a fresh EIP-712 approval signed by SENTINEL's policy
 *         signer (the AI policy oracle).
 *
 * The security model — the whole point of the project:
 *
 *   The natural-language policy is evaluated off-chain by an LLM. When (and only when)
 *   the LLM APPROVES a spend, the policy-signer key signs a single-use EIP-712 approval
 *   bound to {token, recipient, amount, purposeHash, nonce, deadline}. This contract
 *   verifies that signature on-chain before releasing funds.
 *
 *   Consequence: the agent itself, the relayer that pays gas, and any compromised
 *   backend process CANNOT move funds without a valid AI approval. The AI's decision
 *   is not advisory — it is a cryptographic precondition enforced by the EVM on Mantle.
 *
 * Replay-safe: every approval carries a unique nonce that is burned on use, plus a
 * deadline. The domain separator binds approvals to this exact contract + chain (5003),
 * so a signature cannot be replayed on another deployment or network.
 */
contract SentinelVault {
    // ─── EIP-712 ─────────────────────────────────────────────
    bytes32 public constant APPROVAL_TYPEHASH =
        keccak256(
            "Approval(address token,address to,uint256 amount,bytes32 purposeHash,uint256 nonce,uint256 deadline)"
        );
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    bytes32 public immutable DOMAIN_SEPARATOR;

    // ─── Roles ───────────────────────────────────────────────
    address public owner;        // can rotate the policy signer / recover dust
    address public policySigner;  // the AI policy-oracle key — signs approvals
    ISentinelRegistry public registry;

    // ─── Replay protection ──────────────────────────────────
    mapping(uint256 => bool) public usedNonce;
    uint256 public executedCount;

    event PolicySignerUpdated(address indexed previous, address indexed current);
    event RegistryUpdated(address indexed registry);
    event Executed(
        uint256 indexed nonce,
        address indexed token,
        address indexed to,
        uint256 amount,
        bytes32 purposeHash
    );
    event NativeExecuted(uint256 indexed nonce, address indexed to, uint256 amount, bytes32 purposeHash);

    modifier onlyOwner() {
        require(msg.sender == owner, "Vault: not owner");
        _;
    }

    constructor(address _policySigner, address _registry) {
        require(_policySigner != address(0), "Vault: signer=0");
        owner = msg.sender;
        policySigner = _policySigner;
        registry = ISentinelRegistry(_registry);

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("SENTINEL")),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
        emit PolicySignerUpdated(address(0), _policySigner);
    }

    receive() external payable {}

    // ─── Admin ───────────────────────────────────────────────
    function setPolicySigner(address _signer) external onlyOwner {
        require(_signer != address(0), "Vault: signer=0");
        emit PolicySignerUpdated(policySigner, _signer);
        policySigner = _signer;
    }

    function setRegistry(address _registry) external onlyOwner {
        registry = ISentinelRegistry(_registry);
        emit RegistryUpdated(_registry);
    }

    // ─── Core: AI-gated ERC-20 transfer ─────────────────────
    /**
     * @param token       settlement asset (e.g. USDC) held by this vault
     * @param to          approved recipient
     * @param amount      approved amount (token units)
     * @param purposeHash keccak256 of the human-readable purpose the AI judged
     * @param nonce       single-use approval nonce
     * @param deadline    unix seconds after which the approval is void
     * @param signature   EIP-712 Approval signed by `policySigner`
     */
    function executeTransfer(
        address token,
        address to,
        uint256 amount,
        bytes32 purposeHash,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        _consumeApproval(token, to, amount, purposeHash, nonce, deadline, signature);
        require(IERC20(token).transfer(to, amount), "Vault: transfer failed");
        executedCount++;
        emit Executed(nonce, token, to, amount, purposeHash);
    }

    /// @notice AI-gated native MNT transfer (token == address(0) in the signed payload).
    function executeNativeTransfer(
        address to,
        uint256 amount,
        bytes32 purposeHash,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        _consumeApproval(address(0), to, amount, purposeHash, nonce, deadline, signature);
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "Vault: native transfer failed");
        executedCount++;
        emit NativeExecuted(nonce, to, amount, purposeHash);
    }

    function _consumeApproval(
        address token,
        address to,
        uint256 amount,
        bytes32 purposeHash,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) internal {
        require(block.timestamp <= deadline, "Vault: approval expired");
        require(!usedNonce[nonce], "Vault: nonce used");

        bytes32 structHash = keccak256(
            abi.encode(APPROVAL_TYPEHASH, token, to, amount, purposeHash, nonce, deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = _recover(digest, signature);
        require(recovered == policySigner, "Vault: not AI-approved");

        usedNonce[nonce] = true;
    }

    // ─── Views ───────────────────────────────────────────────
    function tokenBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function isNonceUsed(uint256 nonce) external view returns (bool) {
        return usedNonce[nonce];
    }

    // ─── ECDSA recover (no external deps) ───────────────────
    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "Vault: bad sig len");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "Vault: bad v");
        // reject malleable high-s
        require(
            uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0,
            "Vault: bad s"
        );
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "Vault: bad sig");
        return signer;
    }
}
