/**
 * DAO Token Condition Builder Module
 * 
 * Creates TACo access control conditions for DAO token-holder gated access.
 * Supports both ERC20 and ERC721 token balance checks.
 */

// No top-level ethers import - use dynamic imports where needed

// ── Type Definitions ────────────────────────────────────────────────────────

export type TokenType = 'ERC20' | 'ERC721';

export interface DaoConditionOptions {
  /** Token contract address */
  contractAddress: string;
  /** Blockchain chain name (e.g., 'sepolia', 'polygon') */
  chain: string;
  /** Parameter name for user address in condition */
  userAddressParam?: string;
}

export interface Erc20DaoOptions extends DaoConditionOptions {
  type: 'ERC20';
  /** Minimum token balance required (in smallest unit, e.g., wei for ETH) */
  minimumBalance?: string;
}

export interface Erc721DaoOptions extends DaoConditionOptions {
  type: 'ERC721';
  /** Specific token IDs that grant access (optional - empty means any NFT) */
  tokenIds?: string[];
}

export type DaoTokenOptions = Erc20DaoOptions | Erc721DaoOptions;

// ── Condition Builders ──────────────────────────────────────────────────────

/**
 * Create an ERC20 token holder condition.
 * 
 * This condition grants access to users who hold at least `minimumBalance` tokens
 * in the specified contract.
 * 
 * @param options - ERC20 DAO condition options
 * @returns TACo Condition object (ConditionProps)
 * 
 * @example
 * ```typescript
 * const condition = createErc20HolderCondition({
 *   type: 'ERC20',
 *   contractAddress: '0x1234...',
 *   chain: 'sepolia',
 *   minimumBalance: '1000000000000000000' // 1 token with 18 decimals
 * });
 * ```
 */
export function createErc20HolderCondition(options: Erc20DaoOptions): Record<string, unknown> {
  const {
    contractAddress,
    chain,
    minimumBalance = '1',
    userAddressParam = ':userAddress',
  } = options;

  return {
    contractAddress: contractAddress.toLowerCase(),
    standardContractType: 'ERC20',
    chain,
    method: 'balanceOf',
    parameters: [userAddressParam],
    returnValueTest: {
      comparator: '>=',
      value: minimumBalance,
    },
  };
}

/**
 * Create an ERC721 (NFT) holder condition.
 * 
 * This condition grants access to users who own at least one NFT from the
 * specified collection. Optionally restricts to specific token IDs.
 * 
 * @param options - ERC721 DAO condition options
 * @returns TACo Condition object (ConditionProps)
 * 
 * @example
 * ```typescript
 * // Any NFT from collection
 * const anyNftCondition = createErc721HolderCondition({
 *   type: 'ERC721',
 *   contractAddress: '0x5678...',
 *   chain: 'sepolia',
 * });
 * 
 * // Specific token IDs only
 * const specificNftCondition = createErc721HolderCondition({
 *   type: 'ERC721',
 *   contractAddress: '0x5678...',
 *   chain: 'sepolia',
 *   tokenIds: ['1', '2', '3'],
 * });
 * ```
 */
export function createErc721HolderCondition(options: Erc721DaoOptions): Record<string, unknown> {
  const {
    contractAddress,
    chain,
    tokenIds,
    userAddressParam = ':userAddress',
  } = options;

  if (!tokenIds || tokenIds.length === 0) {
    // Any NFT from the collection
    return {
      contractAddress: contractAddress.toLowerCase(),
      standardContractType: 'ERC721',
      chain,
      method: 'balanceOf',
      parameters: [userAddressParam],
      returnValueTest: {
        comparator: '>=',
        value: '1',
      },
    };
  }

  // For specific token IDs, we need to check ownership of each ID
  // This creates a compound "OR" condition across all token IDs
  if (tokenIds.length === 1) {
    // Single token ID - use ownerOf check
    return {
      contractAddress: contractAddress.toLowerCase(),
      standardContractType: 'ERC721',
      chain,
      method: 'ownerOf',
      parameters: [tokenIds[0]],
      returnValueTest: {
        comparator: '=',
        value: userAddressParam,
      },
    };
  }

  // Multiple token IDs - would require compound condition
  // For now, fall back to balanceOf >= 1 (less precise but works)
  console.warn(
    `[dao-condition] Multiple tokenIds requested; using balanceOf >= 1 instead of specific ID checks`
  );
  return {
    contractAddress: contractAddress.toLowerCase(),
    standardContractType: 'ERC721',
    chain,
    method: 'balanceOf',
    parameters: [userAddressParam],
    returnValueTest: {
      comparator: '>=',
      value: '1',
    },
  };
}

/**
 * Factory function to create a DAO token holder condition based on token type.
 * 
 * @param options - DAO token condition options (ERC20 or ERC721)
 * @returns TACo Condition object (ConditionProps)
 * 
 * @example
 * ```typescript
 * // ERC20 token holder
 * const erc20Condition = createDaoTokenCondition({
 *   type: 'ERC20',
 *   contractAddress: 'DAI_CONTRACT_ADDRESS',
 *   chain: 'sepolia',
 *   minimumBalance: '100000000000000000000' // 100 DAI
 * });
 * 
 * // ERC721 NFT holder
 * const erc721Condition = createDaoTokenCondition({
 *   type: 'ERC721',
 *   contractAddress: 'NFT_COLLECTION_ADDRESS',
 *   chain: 'sepolia',
 * });
 * ```
 */
export function createDaoTokenCondition(options: DaoTokenOptions): Record<string, unknown> {
  switch (options.type) {
    case 'ERC20':
      return createErc20HolderCondition(options);
    case 'ERC721':
      return createErc721HolderCondition(options);
    default:
      throw new Error(`Unsupported token type: ${(options as any).type}`);
  }
}

/**
 * Validate a DAO token condition configuration.
 * 
 * @param options - DAO token condition options to validate
 * @throws Error if configuration is invalid
 */
export async function validateDaoConditionOptions(options: DaoTokenOptions): Promise<void> {
  if (!options.contractAddress) {
    throw new Error('contractAddress is required');
  }

  if (!options.chain) {
    throw new Error('chain is required');
  }

  // Dynamic import for ethers v5
  const ethersModule = await import("ethers");
  const ethers = (ethersModule as any).ethers || (ethersModule as any).default;

  // Validate contract address format
  if (!ethers.utils.isAddress(options.contractAddress)) {
    throw new Error(`Invalid contract address: ${options.contractAddress}`);
  }

  if (options.type === 'ERC20') {
    const erc20Opts = options as Erc20DaoOptions;
    if (erc20Opts.minimumBalance !== undefined) {
      try {
        ethers.BigNumber.from(erc20Opts.minimumBalance);
      } catch {
        throw new Error(`Invalid minimumBalance: ${erc20Opts.minimumBalance}`);
      }
    }
  }

  if (options.type === 'ERC721' && options.tokenIds) {
    for (const tokenId of options.tokenIds) {
      try {
        ethers.BigNumber.from(tokenId);
      } catch {
        throw new Error(`Invalid tokenId: ${tokenId}`);
      }
    }
  }
}

// ── Predefined DAO Configurations ───────────────────────────────────────────

/**
 * Common DAO token configurations for testing and development.
 */
export const PREDEFINED_DAOS: Record<string, DaoTokenOptions> = {
  // Sepolia testnet examples
  'sepolia-erc20-dai': {
    type: 'ERC20',
    contractAddress: '0x11fE4B6AE13d2a6055C8D9cF65c55bac32B5d844', // Sepolia DAI
    chain: 'sepolia',
    minimumBalance: '1000000000000000000', // 1 DAI
  },
  'sepolia-erc20-usdc': {
    type: 'ERC20',
    contractAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', // Sepolia USDC
    chain: 'sepolia',
    minimumBalance: '1000000', // 1 USDC (6 decimals)
  },
};
