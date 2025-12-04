pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract FuserFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error RateLimited();
    error InvalidBatch();
    error BatchClosed();
    error StaleWrite();
    error InvalidStateHash();
    error AlreadyProcessed();
    error InvalidCooldown();

    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused();
    event Unpaused();
    event CooldownUpdated(uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event TrackSubmitted(address indexed provider, uint256 indexed batchId, bytes32 trackId);
    event MixSubmitted(address indexed provider, uint256 indexed batchId, bytes32 mixId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionComplete(uint256 indexed requestId, uint256 indexed batchId, uint256 score);
    event CooldownTriggered(address indexed user, uint256 nextAllowed);

    bool public paused;
    uint256 public constant MIN_INTERVAL = 5 seconds;
    uint256 public cooldownInterval = 30 seconds;
    uint256 public currentBatchId;
    uint256 public modelVersion;

    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastActionAt;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => DecryptionContext) public decryptionContexts;
    mapping(bytes32 => euint32) public encryptedTracks;
    mapping(bytes32 => euint32) public encryptedMixes;

    struct Batch {
        bool isActive;
        uint256 modelVersion;
        uint256 trackCount;
        uint256 mixCount;
        euint32 aggregatedScore;
    }

    struct DecryptionContext {
        uint256 batchId;
        uint256 modelVersion;
        bytes32 stateHash;
        bool processed;
        address requester;
    }

    modifier onlyOwner() {
        if (msg.sender != owner()) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier rateLimit() {
        if (block.timestamp < lastActionAt[msg.sender] + cooldownInterval) {
            emit CooldownTriggered(msg.sender, lastActionAt[msg.sender] + cooldownInterval);
            revert RateLimited();
        }
        lastActionAt[msg.sender] = block.timestamp;
        _;
    }

    constructor() {
        isProvider[msg.sender] = true;
        modelVersion = 1;
        _startNewBatch();
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused();
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused();
    }

    function setCooldownInterval(uint256 newInterval) external onlyOwner {
        if (newInterval < MIN_INTERVAL) revert InvalidCooldown();
        cooldownInterval = newInterval;
        emit CooldownUpdated(newInterval);
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        isProvider[provider] = false;
        emit ProviderRemoved(provider);
    }

    function startNewBatch() external onlyOwner whenNotPaused {
        _startNewBatch();
    }

    function closeCurrentBatch() external onlyOwner whenNotPaused {
        if (!batches[currentBatchId].isActive) revert InvalidBatch();
        batches[currentBatchId].isActive = false;
        emit BatchClosed(currentBatchId);
    }

    function submitEncryptedTrack(bytes32 trackId, euint32 encryptedTrack) 
        external 
        onlyProvider 
        whenNotPaused 
        rateLimit 
    {
        if (!batches[currentBatchId].isActive) revert BatchClosed();
        if (batches[currentBatchId].modelVersion != modelVersion) revert StaleWrite();

        encryptedTracks[trackId] = _initIfNeeded(encryptedTrack);
        batches[currentBatchId].trackCount++;
        emit TrackSubmitted(msg.sender, currentBatchId, trackId);
    }

    function submitEncryptedMix(bytes32 mixId, euint32 encryptedMix) 
        external 
        onlyProvider 
        whenNotPaused 
        rateLimit 
    {
        if (!batches[currentBatchId].isActive) revert BatchClosed();
        if (batches[currentBatchId].modelVersion != modelVersion) revert StaleWrite();

        encryptedMixes[mixId] = _initIfNeeded(encryptedMix);
        batches[currentBatchId].mixCount++;
        emit MixSubmitted(msg.sender, currentBatchId, mixId);
    }

    function requestBatchScore(uint256 batchId) 
        external 
        whenNotPaused 
        rateLimit 
        returns (uint256 requestId) 
    {
        if (batchId > currentBatchId || !batches[batchId].isActive) revert InvalidBatch();
        if (batches[batchId].modelVersion != modelVersion) revert StaleWrite();

        euint32 memory score = _computeBatchScore(batchId);
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(score);

        bytes32 stateHash = _hashCiphertexts(cts);
        requestId = FHE.requestDecryption(cts, this.onDecryptionComplete.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId,
            modelVersion: modelVersion,
            stateHash: stateHash,
            processed: false,
            requester: msg.sender
        });

        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function onDecryptionComplete(uint256 requestId, bytes memory cleartexts, bytes memory proof) 
        public 
    {
        if (decryptionContexts[requestId].processed) revert AlreadyProcessed();
        if (msg.sender != address(this) && msg.sender != owner()) revert NotOwner();

        DecryptionContext memory context = decryptionContexts[requestId];
        euint32 memory score = _rebuildCiphertextsForBatch(context.batchId);
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(score);

        bytes32 currHash = _hashCiphertexts(cts);
        if (currHash != context.stateHash) revert InvalidStateHash();

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint256 plainScore = abi.decode(cleartexts, (uint256));
        decryptionContexts[requestId].processed = true;

        emit DecryptionComplete(requestId, context.batchId, plainScore);
    }

    function _startNewBatch() internal {
        currentBatchId++;
        batches[currentBatchId] = Batch({
            isActive: true,
            modelVersion: modelVersion,
            trackCount: 0,
            mixCount: 0,
            aggregatedScore: euint32.wrap(0)
        });
        emit BatchOpened(currentBatchId);
    }

    function _computeBatchScore(uint256 batchId) internal view returns (euint32 memory) {
        if (batches[batchId].trackCount == 0 || batches[batchId].mixCount == 0) {
            return euint32.wrap(0);
        }
        return batches[batchId].aggregatedScore;
    }

    function _rebuildCiphertextsForBatch(uint256 batchId) internal view returns (euint32 memory) {
        return batches[batchId].aggregatedScore;
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts));
    }

    function _initIfNeeded(euint32 x) internal pure returns (euint32 memory) {
        return FHE.isInitialized(x) ? x : euint32.wrap(0);
    }

    function _requireInitialized(euint32 x, string memory tag) internal pure {
        if (!FHE.isInitialized(x)) revert(string(abi.encodePacked(tag, " not initialized")));
    }
}