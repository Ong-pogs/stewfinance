/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/stewfi.json`.
 */
export type Stewfi = {
  "address": "8uDmfYPMBaiLLwfZGAnhNaDm48kx19hD8kPdiR7XiRLD",
  "metadata": {
    "name": "stewfi",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "cancelDraw",
      "docs": [
        "PERMISSIONLESS, TIMEOUT-GATED stuck-draw recovery (audit M-01 + M-02).",
        "",
        "A Committed draw can only be cancelled once it has been stuck past",
        "`DRAW_TIMEOUT` (the oracle never revealed in time, so the round can never",
        "be settled). ANYONE may call this — it does not depend on the admin being",
        "online — which restores deposit/withdraw liveness after a stall (M-02).",
        "",
        "It also kills admin reveal-grinding (M-01): there is no admin-at-will",
        "cancel anymore. A HEALTHY (revealable) draw cannot be cancelled, so an",
        "admin can no longer peek the revealed VRF, dislike the winner, and",
        "abort-and-retry. By the time the timeout elapses the VRF is unusable for",
        "settle anyway — Switchboard `get_value(clock.slot)` only returns the value",
        "when `clock.slot == reveal_slot`, and an hour is thousands of slots past",
        "reveal_slot (verified in the crate source: randomness.rs get_value) — so",
        "cancelling a timed-out draw discards nothing that could have been settled.",
        "",
        "On cancel: reset the round to Pending (clearing all commit state) AND",
        "advance `next_draw_ts` by one cadence period, so there is no instant",
        "re-trigger loop. No funds move (nothing was distributed pre-settle)."
      ],
      "discriminator": [
        105,
        47,
        245,
        199,
        42,
        255,
        88,
        48
      ],
      "accounts": [
        {
          "name": "crank",
          "docs": [
            "Permissionless: anyone may unstick a timed-out draw (audit M-02). The",
            "signer pays only the tx fee — no admin gating, no account init here."
          ],
          "signer": true
        },
        {
          "name": "poolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "currentDraw",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  114,
                  97,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.current_round",
                "account": "poolConfig"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "claimDraw",
      "docs": [
        "Winner pulls their 65%. The prize was held in usdc_vault since settle."
      ],
      "discriminator": [
        136,
        83,
        178,
        200,
        169,
        220,
        3,
        22
      ],
      "accounts": [
        {
          "name": "winner",
          "writable": true,
          "signer": true
        },
        {
          "name": "poolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "draw",
          "docs": [
            "The won round's Draw — must be Settled, winner matches, not yet claimed."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  114,
                  97,
                  119
                ]
              },
              {
                "kind": "arg",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "usdcVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "winnerUsdc",
          "docs": [
            "Winner's USDC token account."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "round",
          "type": "u64"
        }
      ]
    },
    {
      "name": "compoundGrowingPot",
      "docs": [
        "PERMISSIONLESS crank. Deposit the ENTIRE growing_pot_vault balance into the",
        "pot's Kamino obligation via klend",
        "`deposit_reserve_liquidity_and_obligation_collateral_v2` (same CPI as",
        "deposit_to_kamino, but `user_source_liquidity = growing_pot_vault` and",
        "obligation = pot_obligation). The pot principal starts earning yield.",
        "",
        "Permissionless is safe: funds only move growing_pot_vault → klend (still",
        "owned by the pot obligation, whose owner is the pool_config PDA). A griefer",
        "cannot extract value — only deploy idle pot USDC into yield. Blocked during",
        "a draw so pot accounting can't shift mid-draw.",
        "",
        "The crank MUST prepend klend refresh_reserve + refresh_obligation (for the",
        "POT obligation) in the same tx."
      ],
      "discriminator": [
        207,
        75,
        105,
        255,
        218,
        166,
        12,
        152
      ],
      "accounts": [
        {
          "name": "poolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "crank",
          "docs": [
            "Anyone can crank this."
          ],
          "signer": true
        },
        {
          "name": "growingPotVault",
          "docs": [
            "The pot's USDC vault (PDA-owned) = klend `user_source_liquidity`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  114,
                  111,
                  119,
                  105,
                  110,
                  103,
                  95,
                  112,
                  111,
                  116,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "obligation",
          "writable": true
        },
        {
          "name": "lendingMarket"
        },
        {
          "name": "lendingMarketAuthority"
        },
        {
          "name": "reserve",
          "writable": true
        },
        {
          "name": "reserveLiquidityMint"
        },
        {
          "name": "reserveLiquiditySupply",
          "writable": true
        },
        {
          "name": "reserveCollateralMint",
          "writable": true
        },
        {
          "name": "reserveDestinationDepositCollateral",
          "writable": true
        },
        {
          "name": "collateralTokenProgram"
        },
        {
          "name": "liquidityTokenProgram"
        },
        {
          "name": "instructionSysvarAccount"
        },
        {
          "name": "obligationFarmUserState",
          "writable": true
        },
        {
          "name": "reserveFarmState",
          "writable": true
        },
        {
          "name": "farmsProgram"
        },
        {
          "name": "klendProgram",
          "address": "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
        }
      ],
      "args": []
    },
    {
      "name": "deposit",
      "docs": [
        "Deposit USDC into the pool.",
        "First call creates the user's UserPosition; subsequent calls top it up.",
        "Bounds: amount >= MIN_DEPOSIT and cumulative <= MAX_DEPOSIT_PER_WALLET.",
        "Blocked if pool is paused OR if user already requested a withdraw."
      ],
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "poolConfig",
          "docs": [
            "PoolConfig — mutable: deposit maintains the M4 principal + weight",
            "accumulators (total_principal, sum_amount, sum_amount_first_ts)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "userPosition",
          "docs": [
            "UserPosition PDA: created on first deposit, updated on subsequent ones.",
            "`init_if_needed` lets a single instruction handle both — protected by our",
            "bounds checks (MAX_DEPOSIT_PER_WALLET) so reinit-style attacks can't grow",
            "the position past the cap."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "usdcVault",
          "docs": [
            "The pool's USDC vault (PDA-owned)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "userUsdc",
          "docs": [
            "User's USDC token account. Must match the mint + be owned by user."
          ],
          "writable": true
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "depositToKamino",
      "docs": [
        "Permissionless crank. Move `amount` USDC from usdc_vault into Kamino Lend",
        "via klend `deposit_reserve_liquidity_and_obligation_collateral_v2`.",
        "",
        "Idle USDC starts earning. Collateral (cTokens) is booked straight into the",
        "pool obligation — StewFi does NOT need its own cToken vault for this",
        "combined deposit ix (`placeholder_user_destination_collateral` is None).",
        "",
        "Permissionless is safe: funds only move usdc_vault → klend (still owned by",
        "the pool obligation, whose owner is the pool_config PDA). A griefer cannot",
        "extract value, only deploy idle pool USDC into yield.",
        "",
        "The crank MUST prepend klend `refresh_reserve` + `refresh_obligation` in",
        "the same tx (see module docs).",
        "",
        "Farm accounts: pass the real reserve_farm_state + obligation_farm_user_state",
        "for a reserve that has a collateral farm (mainnet USDC does). For a",
        "farmless reserve, pass the klend program account for both (= None)."
      ],
      "discriminator": [
        107,
        90,
        118,
        214,
        59,
        19,
        144,
        80
      ],
      "accounts": [
        {
          "name": "poolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "crank",
          "docs": [
            "Anyone can crank this."
          ],
          "signer": true
        },
        {
          "name": "usdcVault",
          "docs": [
            "The pool's USDC vault (PDA-owned) = klend `user_source_liquidity`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "obligation",
          "writable": true
        },
        {
          "name": "lendingMarket"
        },
        {
          "name": "lendingMarketAuthority"
        },
        {
          "name": "reserve",
          "writable": true
        },
        {
          "name": "reserveLiquidityMint"
        },
        {
          "name": "reserveLiquiditySupply",
          "writable": true
        },
        {
          "name": "reserveCollateralMint",
          "writable": true
        },
        {
          "name": "reserveDestinationDepositCollateral",
          "writable": true
        },
        {
          "name": "collateralTokenProgram"
        },
        {
          "name": "liquidityTokenProgram"
        },
        {
          "name": "instructionSysvarAccount"
        },
        {
          "name": "obligationFarmUserState",
          "writable": true
        },
        {
          "name": "reserveFarmState",
          "writable": true
        },
        {
          "name": "farmsProgram"
        },
        {
          "name": "klendProgram",
          "address": "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "harvestGrowingPotYield",
      "docs": [
        "PERMISSIONLESS crank. Run BEFORE trigger_draw each week. Fully redeems the",
        "pot's Kamino position into usdc_vault (klend",
        "`withdraw_obligation_collateral_and_redeem_reserve_collateral_v2`, same CPI",
        "as withdraw_from_kamino), then splits the proceeds IN PLAIN USDC (no",
        "exchange-rate math anywhere):",
        "principal_return = min(total_redeemed, pot_principal_usdc)  -> back to",
        "growing_pot_vault (so it is NOT in the prize; the next",
        "compound re-invests it)",
        "yield_amount     = total_redeemed - principal_return        -> STAYS in",
        "usdc_vault → captured by trigger_draw's existing",
        "prize formula.",
        "",
        "`full_collateral_amount` is the pot obligation's ENTIRE current cToken",
        "balance (read off-chain via readObligationCollateral). cToken units, NOT",
        "USDC. If the pot has 0 cTokens (e.g. the very first draw) the crank should",
        "skip calling this entirely; defensively, if total_redeemed comes back 0 we",
        "return NoPotYield. A FLAT week (redeemed == principal → yield 0) is allowed",
        "and is NOT an error.",
        "",
        "Permissionless is safe: USDC only flows klend → usdc_vault and",
        "usdc_vault → growing_pot_vault, both PDA-owned. A griefer can only move",
        "pot funds among the pool's own vaults, never out. Blocked during a draw.",
        "",
        "The crank MUST prepend klend refresh_reserve + refresh_obligation (for the",
        "POT obligation) in the same tx."
      ],
      "discriminator": [
        223,
        76,
        75,
        162,
        178,
        2,
        225,
        197
      ],
      "accounts": [
        {
          "name": "poolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "crank",
          "docs": [
            "Anyone can crank this."
          ],
          "signer": true
        },
        {
          "name": "usdcVault",
          "docs": [
            "The pool's USDC vault (PDA-owned) = klend `user_destination_liquidity`.",
            "Redeemed USDC lands here; the pot-principal slice is then transferred back",
            "to growing_pot_vault, leaving only the yield for the prize formula."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "growingPotVault",
          "docs": [
            "The pot's USDC vault (PDA-owned) — receives the returned principal."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  114,
                  111,
                  119,
                  105,
                  110,
                  103,
                  95,
                  112,
                  111,
                  116,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "obligation",
          "writable": true
        },
        {
          "name": "lendingMarket"
        },
        {
          "name": "lendingMarketAuthority"
        },
        {
          "name": "reserve",
          "writable": true
        },
        {
          "name": "reserveLiquidityMint"
        },
        {
          "name": "reserveSourceCollateral",
          "writable": true
        },
        {
          "name": "reserveCollateralMint",
          "writable": true
        },
        {
          "name": "reserveLiquiditySupply",
          "writable": true
        },
        {
          "name": "collateralTokenProgram"
        },
        {
          "name": "liquidityTokenProgram"
        },
        {
          "name": "instructionSysvarAccount"
        },
        {
          "name": "obligationFarmUserState",
          "writable": true
        },
        {
          "name": "reserveFarmState",
          "writable": true
        },
        {
          "name": "farmsProgram"
        },
        {
          "name": "klendProgram",
          "address": "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "fullCollateralAmount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initDrawAccounts",
      "docs": [
        "Admin-only, one-time. Stand up the M4 draw infrastructure:",
        "- growing_pot_vault / operator_vault / ops_vault (PDA-owned USDC accts)",
        "- record operator + ops payout pubkeys",
        "- create the round-0 `Draw` (status Pending, accepting deposits)",
        "- arm the weekly cadence (`next_draw_ts = now + draw_interval`)",
        "",
        "Kept separate from M1 `initialize` so M1's tested account list is untouched."
      ],
      "discriminator": [
        121,
        213,
        161,
        173,
        177,
        16,
        83,
        213
      ],
      "accounts": [
        {
          "name": "poolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "usdcMint",
          "docs": [
            "USDC mint (must match the pool's). Used to seed the vault PDAs."
          ]
        },
        {
          "name": "currentDraw",
          "docs": [
            "Round-0 Draw — the steady state that accepts deposits until triggered."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  114,
                  97,
                  119
                ]
              },
              {
                "kind": "const",
                "value": [
                  0,
                  0,
                  0,
                  0,
                  0,
                  0,
                  0,
                  0
                ]
              }
            ]
          }
        },
        {
          "name": "growingPotVault",
          "docs": [
            "20% Growing-Pot escrow (M5 sweeps). PDA-owned USDC account."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  114,
                  111,
                  119,
                  105,
                  110,
                  103,
                  95,
                  112,
                  111,
                  116,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ]
          }
        },
        {
          "name": "operatorVault",
          "docs": [
            "10% operator escrow. PDA-owned USDC account."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  112,
                  101,
                  114,
                  97,
                  116,
                  111,
                  114,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ]
          }
        },
        {
          "name": "opsVault",
          "docs": [
            "5% ops escrow. PDA-owned USDC account."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  112,
                  115,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "operator",
          "type": "pubkey"
        },
        {
          "name": "ops",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "initGrowingPotFarm",
      "docs": [
        "Admin-only, one-time. Create the POT obligation's farm-user-state for the",
        "USDC reserve's collateral farm (klend `init_obligation_farms_for_reserve`).",
        "",
        "Mirrors init_kamino_farm exactly, but for the pot obligation. Required",
        "because the mainnet USDC reserve has a NON-default collateral farm, so the",
        "pot's deposit/withdraw `_v2` CPIs need a populated obligation_farm_user_state",
        "(else klend returns `FarmAccountsMissing`). For a farmless reserve this is",
        "unnecessary — callers can skip it and pass klend-program placeholders."
      ],
      "discriminator": [
        206,
        54,
        240,
        213,
        178,
        154,
        155,
        181
      ],
      "accounts": [
        {
          "name": "poolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "obligation",
          "writable": true
        },
        {
          "name": "lendingMarketAuthority"
        },
        {
          "name": "reserve",
          "writable": true
        },
        {
          "name": "reserveFarmState",
          "writable": true
        },
        {
          "name": "obligationFarmUserState",
          "docs": [
            "klend pot-obligation farm-user-state PDA — created by the CPI."
          ],
          "writable": true
        },
        {
          "name": "lendingMarket"
        },
        {
          "name": "farmsProgram"
        },
        {
          "name": "klendProgram",
          "address": "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initGrowingPotObligation",
      "docs": [
        "Admin-only, one-time. Stand up the pot's OWN Kamino obligation (Vanilla",
        "tag=0, id=1), owned by the pool_config PDA.",
        "",
        "Reuses the EXISTING per-owner UserMetadata created in M3",
        "(init_kamino_obligation already ran `init_user_metadata` for owner =",
        "pool_config). klend allows multiple obligations under one",
        "owner_user_metadata, so this ix calls ONLY `init_obligation` — it must NOT",
        "re-init user_metadata (re-init would fail). Requires the M3 obligation to",
        "already exist (so we know UserMetadata is present)."
      ],
      "discriminator": [
        16,
        137,
        168,
        45,
        13,
        73,
        62,
        105
      ],
      "accounts": [
        {
          "name": "poolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "userMetadata",
          "docs": [
            "klend UserMetadata PDA `[b\"user_meta\", pool_config]` — REUSED from M3",
            "(already created by init_kamino_obligation; this ix does NOT re-init it)."
          ],
          "writable": true
        },
        {
          "name": "obligation",
          "docs": [
            "klend POT obligation PDA (tag=0, id=1) — created by the CPI."
          ],
          "writable": true
        },
        {
          "name": "lendingMarket"
        },
        {
          "name": "seed1Account",
          "docs": [
            "Vanilla obligation seed account #1 — must be the default pubkey."
          ],
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "seed2Account",
          "docs": [
            "Vanilla obligation seed account #2 — must be the default pubkey."
          ],
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "klendProgram",
          "address": "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initKaminoFarm",
      "docs": [
        "Admin-only, one-time per reserve. Create the obligation's farm-user-state",
        "for the USDC reserve's collateral farm via klend",
        "`init_obligation_farms_for_reserve`.",
        "",
        "Why this exists: the mainnet USDC reserve has a NON-default collateral farm",
        "(`reserve.farm_collateral`). klend's v2 deposit/withdraw refresh logic",
        "REQUIRES both farm accounts when the reserve has a farm — passing \"None\"",
        "for them fails with `FarmAccountsMissing`. So we must create the per-",
        "obligation farm-user-state once, then pass it (plus the reserve farm",
        "state) into every deposit/withdraw crank.",
        "",
        "For a FARMLESS reserve this instruction is unnecessary — callers can skip",
        "it and pass klend-program placeholders for the farm accounts instead."
      ],
      "discriminator": [
        170,
        181,
        171,
        91,
        5,
        84,
        215,
        223
      ],
      "accounts": [
        {
          "name": "poolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "obligation",
          "writable": true
        },
        {
          "name": "lendingMarketAuthority"
        },
        {
          "name": "reserve",
          "writable": true
        },
        {
          "name": "reserveFarmState",
          "writable": true
        },
        {
          "name": "obligationFarmUserState",
          "docs": [
            "klend obligation-farm-user-state PDA — created by the CPI."
          ],
          "writable": true
        },
        {
          "name": "lendingMarket"
        },
        {
          "name": "farmsProgram"
        },
        {
          "name": "klendProgram",
          "address": "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initKaminoObligation",
      "docs": [
        "Admin-only, one-time. Stand up the pool's Kamino lending obligation.",
        "Folds two klend CPIs:",
        "1. `init_user_metadata` — klend requires a per-owner UserMetadata PDA to",
        "exist before an obligation can be created.",
        "2. `init_obligation` — creates the Vanilla obligation (tag=0, id=0) owned",
        "by the pool_config PDA.",
        "Stores the obligation pubkey into PoolConfig."
      ],
      "discriminator": [
        96,
        224,
        121,
        22,
        124,
        195,
        140,
        210
      ],
      "accounts": [
        {
          "name": "poolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "userMetadata",
          "docs": [
            "klend UserMetadata PDA `[b\"user_meta\", pool_config]` — created by the CPI."
          ],
          "writable": true
        },
        {
          "name": "obligation",
          "docs": [
            "klend obligation PDA — created by the CPI."
          ],
          "writable": true
        },
        {
          "name": "lendingMarket"
        },
        {
          "name": "seed1Account",
          "docs": [
            "Vanilla obligation seed account #1 — must be the default pubkey."
          ],
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "seed2Account",
          "docs": [
            "Vanilla obligation seed account #2 — must be the default pubkey."
          ],
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "klendProgram",
          "address": "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initialize",
      "docs": [
        "One-time admin-only setup.",
        "Creates PoolConfig PDA (singleton per usdc_mint) and the PDA-owned USDC vault."
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "poolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ]
          }
        },
        {
          "name": "usdcVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "requestWithdraw",
      "docs": [
        "Mark that the user wants to withdraw — starts the 24h cooldown timer.",
        "No funds move. Just sets withdraw_requested_at = now."
      ],
      "discriminator": [
        137,
        95,
        187,
        96,
        250,
        138,
        31,
        182
      ],
      "accounts": [
        {
          "name": "userPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "user",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "setNextDrawTs",
      "docs": [
        "Admin-only: set the earliest unix timestamp at which the next draw may",
        "`trigger_draw`. `init_draw_accounts` arms the cadence 7 days out; this lets",
        "the admin open the first draw immediately or reschedule. Operational control",
        "only — moves no funds, does not touch weights or the in-progress lock."
      ],
      "discriminator": [
        7,
        216,
        97,
        158,
        105,
        132,
        76,
        99
      ],
      "accounts": [
        {
          "name": "poolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "ts",
          "type": "i64"
        }
      ]
    },
    {
      "name": "setOperator",
      "docs": [
        "Admin-gated operator rotation (audit L-01). Updates `pool_config.operator`",
        "so a compromised/lost operator key can be replaced without redeploying",
        "state. The new operator immediately gains trigger/settle rights and is the",
        "destination authority for `sweep_operator_fees`."
      ],
      "discriminator": [
        238,
        153,
        101,
        169,
        243,
        131,
        36,
        1
      ],
      "accounts": [
        {
          "name": "poolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "newOperator",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setPaused",
      "docs": [
        "Admin-only setter for `paused` (fixes audit F-02: `paused` had no setter)."
      ],
      "discriminator": [
        91,
        60,
        125,
        192,
        176,
        225,
        166,
        218
      ],
      "accounts": [
        {
          "name": "poolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "settleDraw",
      "docs": [
        "Operator-gated. Atomic with the Switchboard `revealIx` (same tx). Reads",
        "the revealed value slot-bound (`get_value(clock.slot)`), determines the",
        "winner FULLY ON-CHAIN by iterating every live position, splits the prize",
        "65/20/10/5, advances the round, and unlocks deposits.",
        "",
        "remaining_accounts: ALL live `UserPosition`s for the pool, in CANONICAL",
        "order — ascending by `user` pubkey. The crank passes them; the program",
        "does NOT trust their order or completeness blindly — it verifies both.",
        "",
        "Trustless verify (the winner is DERIVED, not supplied):",
        "1. ticket `t = u128(value[0..16]) % draw.total_weight` (total_weight is",
        "the on-chain accumulator snapshot from commit — not a crank input).",
        "2. Iterate remaining_accounts: each must be a real `UserPosition` owned",
        "by THIS program (Account::try_from checks owner + discriminator), at",
        "its canonical PDA `[b\"user_position\", user]`, in STRICTLY ascending",
        "`user` order (rejects dups / reorderings / omissions of ordering).",
        "Accumulate `running_weight += amount × (draw_ts − first_deposit_ts)`",
        "and track each position's `[cum_before, cum_before + weight)` window.",
        "3. COMPLETENESS: `running_weight == draw.total_weight`. Because",
        "draw_in_progress froze the weight set at commit, the live positions",
        "ARE the accumulator's set — so equality proves the passed set is",
        "exactly that set (operator can't omit/add/reorder).",
        "4. The winner is the position whose window contains `t`; require the",
        "passed `winner_position` == that derived winner.",
        "There is no `winner_cum_start` input to forge: the cumulative offset is",
        "computed on-chain from the real positions. A malicious operator cannot",
        "steer the win — the only freedom (the VRF value) is committed before the",
        "reveal, and Switchboard guarantees it's unpredictable at commit time."
      ],
      "discriminator": [
        175,
        154,
        75,
        30,
        118,
        117,
        107,
        194
      ],
      "accounts": [
        {
          "name": "crank",
          "docs": [
            "Operator or admin (checked in the handler)."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "poolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "currentDraw",
          "docs": [
            "Current round's Draw (must be Committed)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  114,
                  97,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.current_round",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "nextDraw",
          "docs": [
            "Next round's Draw, created here (Pending)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  114,
                  97,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.current_round.checked_add(1).ok_or(StewfiError :: Overflow) ?\n",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "randomnessAccount",
          "docs": [
            "The committed randomness account (key checked == current_draw.randomness_account)."
          ]
        },
        {
          "name": "winnerPosition",
          "docs": [
            "The winner position. Anchor verifies it's a real UserPosition at its",
            "canonical PDA. The handler does NOT trust this is the winner — it derives",
            "the winner on-chain by iterating ALL live positions (passed via",
            "remaining_accounts, ascending by `user`) and requires this account ==",
            "the derived winner. Used here so the prize-split + Draw.winner record can",
            "reference the winner's wallet directly. See settle_draw.",
            "",
            "remaining_accounts (NOT in this struct): every live `UserPosition` for the",
            "pool, ordered ascending by `user` pubkey. Required for the trustless",
            "winner derivation + completeness check."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "winner_position.user",
                "account": "userPosition"
              }
            ]
          }
        },
        {
          "name": "usdcVault",
          "docs": [
            "The pot (winner's 65% stays here; 20/10/5 leave here)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "growingPotVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  114,
                  111,
                  119,
                  105,
                  110,
                  103,
                  95,
                  112,
                  111,
                  116,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "operatorVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  112,
                  101,
                  114,
                  97,
                  116,
                  111,
                  114,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "opsVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  112,
                  115,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "sweepOperatorFees",
      "docs": [
        "Operator-gated sweep of the accrued 10% operator cut (audit L-02). Moves",
        "the FULL `operator_vault` balance to an operator-chosen USDC destination.",
        "PDA-signed by pool_config. Touches ONLY operator_vault — never principal",
        "(usdc_vault) or the M5-locked growing_pot_vault."
      ],
      "discriminator": [
        71,
        118,
        187,
        67,
        58,
        163,
        108,
        182
      ],
      "accounts": [
        {
          "name": "crank",
          "docs": [
            "Must be the configured operator (checked in the handler)."
          ],
          "signer": true
        },
        {
          "name": "poolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "operatorVault",
          "docs": [
            "The 10% operator escrow — the ONLY vault this ix may drain."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  112,
                  101,
                  114,
                  97,
                  116,
                  111,
                  114,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "destination",
          "docs": [
            "Operator-chosen USDC destination (mint-checked). The operator owns the",
            "routing decision; we only pin the mint."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "sweepOpsFees",
      "docs": [
        "Admin-gated sweep of the accrued 5% ops cut (audit L-02). Moves the FULL",
        "`ops_vault` balance to an admin-chosen USDC destination. PDA-signed by",
        "pool_config. Touches ONLY ops_vault — never principal or growing_pot."
      ],
      "discriminator": [
        198,
        230,
        216,
        232,
        159,
        234,
        152,
        57
      ],
      "accounts": [
        {
          "name": "admin",
          "docs": [
            "Must be the admin (checked in the handler)."
          ],
          "signer": true
        },
        {
          "name": "poolConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "opsVault",
          "docs": [
            "The 5% ops escrow — the ONLY vault this ix may drain."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  112,
                  115,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "destination",
          "docs": [
            "Admin-chosen USDC destination (mint-checked)."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "triggerDraw",
      "docs": [
        "Operator-gated. Commit the current round to a Switchboard randomness",
        "account and lock the weight set. The crank PREPENDS the Switchboard",
        "`commitIx` in the SAME tx (StewFi does not CPI Switchboard); this ix only",
        "records the randomness account, snapshots the prize + global total_weight,",
        "and flips the round to Committed.",
        "",
        "Snapshotting here (not at settle) pins `draw_ts` and `total_weight` to the",
        "commit moment, so the off-chain crank and on-chain settle use identical",
        "numbers for the winner-window check (see m4-research §9 gotcha-11)."
      ],
      "discriminator": [
        121,
        238,
        5,
        71,
        167,
        160,
        211,
        124
      ],
      "accounts": [
        {
          "name": "crank",
          "docs": [
            "Operator or admin (checked in the handler)."
          ],
          "signer": true
        },
        {
          "name": "poolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "currentDraw",
          "docs": [
            "Current round's Draw (must be Pending)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  114,
                  97,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.current_round",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "usdcVault",
          "docs": [
            "The pool's USDC vault — read for the prize snapshot."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "randomnessAccount",
          "docs": [
            "The Switchboard randomness account (committed off-chain in the same tx)."
          ]
        }
      ],
      "args": []
    },
    {
      "name": "withdraw",
      "docs": [
        "Execute the withdraw — requires (1) request was made, (2) 24h elapsed.",
        "Transfers full position back to user and closes the UserPosition account."
      ],
      "discriminator": [
        183,
        18,
        70,
        156,
        148,
        109,
        161,
        34
      ],
      "accounts": [
        {
          "name": "poolConfig",
          "docs": [
            "PoolConfig — mutable: withdraw maintains the M4 principal + weight",
            "accumulators (subtracts the closed position's full contribution)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "userPosition",
          "docs": [
            "UserPosition closes back to user (rent refund) on success."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "usdcVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "userUsdc",
          "writable": true
        },
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "withdrawFromKamino",
      "docs": [
        "Permissionless crank. Redeem `collateral_amount` cTokens from Kamino back",
        "into usdc_vault via klend",
        "`withdraw_obligation_collateral_and_redeem_reserve_collateral_v2`.",
        "",
        "IMPORTANT: `collateral_amount` is in COLLATERAL (cToken) units, NOT USDC.",
        "To drain the position, read the obligation's deposited collateral amount",
        "off-chain and pass it (klend has no u64::MAX sentinel for this ix).",
        "",
        "Permissionless is safe: USDC only flows klend → usdc_vault (PDA-owned). A",
        "griefer can only move funds back into the pool's own vault, never out.",
        "",
        "The crank MUST prepend klend `refresh_reserve` + `refresh_obligation` in",
        "the same tx (see module docs). Farm-account rules match deposit_to_kamino."
      ],
      "discriminator": [
        177,
        144,
        191,
        109,
        204,
        151,
        38,
        176
      ],
      "accounts": [
        {
          "name": "poolConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "crank",
          "docs": [
            "Anyone can crank this."
          ],
          "signer": true
        },
        {
          "name": "usdcVault",
          "docs": [
            "The pool's USDC vault (PDA-owned) = klend `user_destination_liquidity`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  100,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "pool_config.usdc_mint",
                "account": "poolConfig"
              }
            ]
          }
        },
        {
          "name": "obligation",
          "writable": true
        },
        {
          "name": "lendingMarket"
        },
        {
          "name": "lendingMarketAuthority"
        },
        {
          "name": "reserve",
          "writable": true
        },
        {
          "name": "reserveLiquidityMint"
        },
        {
          "name": "reserveSourceCollateral",
          "writable": true
        },
        {
          "name": "reserveCollateralMint",
          "writable": true
        },
        {
          "name": "reserveLiquiditySupply",
          "writable": true
        },
        {
          "name": "collateralTokenProgram"
        },
        {
          "name": "liquidityTokenProgram"
        },
        {
          "name": "instructionSysvarAccount"
        },
        {
          "name": "obligationFarmUserState",
          "writable": true
        },
        {
          "name": "reserveFarmState",
          "writable": true
        },
        {
          "name": "farmsProgram"
        },
        {
          "name": "klendProgram",
          "address": "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
        }
      ],
      "args": [
        {
          "name": "collateralAmount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "draw",
      "discriminator": [
        225,
        131,
        41,
        222,
        122,
        20,
        146,
        202
      ]
    },
    {
      "name": "poolConfig",
      "discriminator": [
        26,
        108,
        14,
        123,
        116,
        230,
        129,
        43
      ]
    },
    {
      "name": "userPosition",
      "discriminator": [
        251,
        248,
        209,
        245,
        83,
        234,
        17,
        27
      ]
    }
  ],
  "events": [
    {
      "name": "potHarvested",
      "discriminator": [
        236,
        243,
        242,
        240,
        142,
        83,
        142,
        7
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "depositTooSmall",
      "msg": "Deposit amount is below the minimum (10 USDC)"
    },
    {
      "code": 6001,
      "name": "depositTooLarge",
      "msg": "Deposit would exceed the maximum per wallet (5,000 USDC)"
    },
    {
      "code": 6002,
      "name": "poolPaused",
      "msg": "Pool is currently paused"
    },
    {
      "code": 6003,
      "name": "withdrawAlreadyRequested",
      "msg": "A withdraw has already been requested for this position"
    },
    {
      "code": 6004,
      "name": "withdrawNotRequested",
      "msg": "No pending withdraw request — call request_withdraw first"
    },
    {
      "code": 6005,
      "name": "withdrawCooldownActive",
      "msg": "24-hour cooldown has not elapsed since withdraw request"
    },
    {
      "code": 6006,
      "name": "noDeposit",
      "msg": "No active deposit on this position"
    },
    {
      "code": 6007,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6008,
      "name": "wrongMint",
      "msg": "Token account mint does not match the pool's USDC mint"
    },
    {
      "code": 6009,
      "name": "wrongOwner",
      "msg": "Token account is not owned by the signer"
    },
    {
      "code": 6010,
      "name": "unauthorized",
      "msg": "Only the admin may call this instruction"
    },
    {
      "code": 6011,
      "name": "kaminoObligationAlreadyInit",
      "msg": "Kamino obligation has already been initialized"
    },
    {
      "code": 6012,
      "name": "kaminoObligationNotInit",
      "msg": "Kamino obligation has not been initialized yet"
    },
    {
      "code": 6013,
      "name": "wrongKaminoObligation",
      "msg": "Provided obligation does not match the pool's Kamino obligation"
    },
    {
      "code": 6014,
      "name": "invalidAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6015,
      "name": "insufficientVaultBalance",
      "msg": "USDC vault balance is insufficient for this deposit"
    },
    {
      "code": 6016,
      "name": "drawInProgress",
      "msg": "A draw is in progress — deposits/withdrawals are locked"
    },
    {
      "code": 6017,
      "name": "drawAccountsAlreadyInit",
      "msg": "Draw accounts have already been initialized"
    },
    {
      "code": 6018,
      "name": "drawAccountsNotInit",
      "msg": "Draw accounts have not been initialized yet"
    },
    {
      "code": 6019,
      "name": "drawNotReady",
      "msg": "It is not yet time for the next draw"
    },
    {
      "code": 6020,
      "name": "invalidDrawStatus",
      "msg": "Draw is not in the expected state for this action"
    },
    {
      "code": 6021,
      "name": "noEntries",
      "msg": "No eligible entries (total weight is zero)"
    },
    {
      "code": 6022,
      "name": "fundsStillInKamino",
      "msg": "Funds are still in Kamino — harvest into the vault before drawing"
    },
    {
      "code": 6023,
      "name": "nothingToDraw",
      "msg": "No prize to draw (vault has no yield over principal)"
    },
    {
      "code": 6024,
      "name": "invalidRandomnessAccount",
      "msg": "Randomness account is invalid or not a Switchboard On-Demand account"
    },
    {
      "code": 6025,
      "name": "randomnessAlreadyRevealed",
      "msg": "Randomness account has already been revealed (single-use)"
    },
    {
      "code": 6026,
      "name": "randomnessNotResolved",
      "msg": "Randomness has not been revealed for the current slot"
    },
    {
      "code": 6027,
      "name": "badWinnerProof",
      "msg": "Winner proof failed: the claimed winner does not match the VRF result"
    },
    {
      "code": 6028,
      "name": "badPositionAccount",
      "msg": "A passed position account is not a valid UserPosition for this pool"
    },
    {
      "code": 6029,
      "name": "positionsNotSorted",
      "msg": "Positions must be passed in strictly ascending order by user pubkey"
    },
    {
      "code": 6030,
      "name": "incompletePositionSet",
      "msg": "Passed position set is incomplete: summed weight != snapshot total_weight"
    },
    {
      "code": 6031,
      "name": "drawNotTimedOut",
      "msg": "Draw has not been stuck long enough to cancel (timeout not elapsed)"
    },
    {
      "code": 6032,
      "name": "nothingToSweep",
      "msg": "Nothing to sweep — the fee vault is empty"
    },
    {
      "code": 6033,
      "name": "potObligationAlreadyInit",
      "msg": "The growing-pot obligation has already been initialized"
    },
    {
      "code": 6034,
      "name": "potObligationNotInit",
      "msg": "The growing-pot obligation has not been initialized yet"
    },
    {
      "code": 6035,
      "name": "wrongPotObligation",
      "msg": "Provided obligation does not match the pool's growing-pot obligation"
    },
    {
      "code": 6036,
      "name": "noPotYield",
      "msg": "Pot redeem returned nothing — the pot has no position to harvest"
    }
  ],
  "types": [
    {
      "name": "draw",
      "docs": [
        "Per-round draw state (PDA `[b\"draw\", round.to_le_bytes()]`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "docs": [
              "Which round this draw represents."
            ],
            "type": "u64"
          },
          {
            "name": "status",
            "docs": [
              "State-machine position."
            ],
            "type": {
              "defined": {
                "name": "drawStatus"
              }
            }
          },
          {
            "name": "randomnessAccount",
            "docs": [
              "Switchboard randomness account committed for this round (default until commit)."
            ],
            "type": "pubkey"
          },
          {
            "name": "drawTs",
            "docs": [
              "Timestamp pinned at commit; used for the winner's seconds_held at settle."
            ],
            "type": "i64"
          },
          {
            "name": "committedTs",
            "docs": [
              "Unix ts at which the round was committed (set in trigger_draw, 0 otherwise).",
              "Gates the permissionless timeout cancel: a Committed draw may only be",
              "cancelled once `now > committed_ts + DRAW_TIMEOUT` (audit M-01/M-02)."
            ],
            "type": "i64"
          },
          {
            "name": "totalWeight",
            "docs": [
              "Global total weight snapshotted at commit (on-chain, trustless)."
            ],
            "type": "u128"
          },
          {
            "name": "prizePool",
            "docs": [
              "Prize (USDC) snapshotted at commit = vault − principal − pending_winnings."
            ],
            "type": "u64"
          },
          {
            "name": "randomValue",
            "docs": [
              "The 32 revealed VRF bytes (zero until settle)."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "winner",
            "docs": [
              "Winner wallet (default until settle)."
            ],
            "type": "pubkey"
          },
          {
            "name": "winnerAmount",
            "docs": [
              "Winner's 65% (+ dust), held in usdc_vault until claim_draw."
            ],
            "type": "u64"
          },
          {
            "name": "growingPotAmount",
            "docs": [
              "20% routed to growing_pot_vault at settle."
            ],
            "type": "u64"
          },
          {
            "name": "operatorAmount",
            "docs": [
              "10% routed to operator_vault at settle."
            ],
            "type": "u64"
          },
          {
            "name": "opsAmount",
            "docs": [
              "5% routed to ops_vault at settle."
            ],
            "type": "u64"
          },
          {
            "name": "winnerClaimed",
            "docs": [
              "Whether the winner has claimed their prize."
            ],
            "type": "bool"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "drawStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "pending"
          },
          {
            "name": "committed"
          },
          {
            "name": "settled"
          },
          {
            "name": "claimed"
          }
        ]
      }
    },
    {
      "name": "poolConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "usdcMint",
            "type": "pubkey"
          },
          {
            "name": "usdcVault",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "currentRound",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "usdcVaultBump",
            "type": "u8"
          },
          {
            "name": "kaminoObligation",
            "docs": [
              "The pool's klend obligation. Pubkey::default() until init_kamino_obligation."
            ],
            "type": "pubkey"
          },
          {
            "name": "kaminoDeposited",
            "docs": [
              "Running principal deployed into Kamino (best-effort; deploy hint only)."
            ],
            "type": "u64"
          },
          {
            "name": "lastKaminoSync",
            "docs": [
              "Unix ts of the last deposit_to_kamino / withdraw_from_kamino crank."
            ],
            "type": "i64"
          },
          {
            "name": "totalPrincipal",
            "docs": [
              "Exact sum of all live UserPosition.amount. Maintained in deposit (+) /",
              "withdraw (−). Authoritative principal for the prize formula",
              "(prize = usdc_vault − total_principal − pending_winnings)."
            ],
            "type": "u64"
          },
          {
            "name": "sumAmount",
            "docs": [
              "Trustless-winner accumulator S1 = Σ live position.amount (u128)."
            ],
            "type": "u128"
          },
          {
            "name": "sumAmountFirstTs",
            "docs": [
              "Trustless-winner accumulator S2 = Σ (position.amount × first_deposit_ts) (u128).",
              "total_weight at a draw = draw_ts × sum_amount − sum_amount_first_ts."
            ],
            "type": "u128"
          },
          {
            "name": "pendingWinnings",
            "docs": [
              "Sum of settled-but-unclaimed winner prizes still sitting in usdc_vault.",
              "Excluded from the prize so a pending prize isn't re-drawn as \"yield\"."
            ],
            "type": "u64"
          },
          {
            "name": "drawInProgress",
            "docs": [
              "True between trigger_draw (commit) and settle_draw/cancel_draw. Blocks",
              "deposit/withdraw so the weight set can't shift mid-draw."
            ],
            "type": "bool"
          },
          {
            "name": "operator",
            "docs": [
              "Operator payout wallet (receives 10% via operator_vault sweep). Also the",
              "non-admin signer allowed to trigger/settle draws."
            ],
            "type": "pubkey"
          },
          {
            "name": "ops",
            "docs": [
              "Ops payout wallet (receives 5% via ops_vault sweep)."
            ],
            "type": "pubkey"
          },
          {
            "name": "drawInterval",
            "docs": [
              "Seconds between draws (set to DRAW_INTERVAL at init; weekly)."
            ],
            "type": "i64"
          },
          {
            "name": "nextDrawTs",
            "docs": [
              "Earliest unix ts the next draw may be triggered."
            ],
            "type": "i64"
          },
          {
            "name": "drawAccountsReady",
            "docs": [
              "True once init_draw_accounts has run (vaults + round-0 Draw exist)."
            ],
            "type": "bool"
          },
          {
            "name": "growingPotVaultBump",
            "docs": [
              "Stored bumps for the M4 PDA vaults."
            ],
            "type": "u8"
          },
          {
            "name": "operatorVaultBump",
            "type": "u8"
          },
          {
            "name": "opsVaultBump",
            "type": "u8"
          },
          {
            "name": "potObligation",
            "docs": [
              "The pot's OWN klend obligation (Vanilla tag=0, id=1). Distinct from the",
              "M3 main-pool obligation (kamino_obligation, id=0). Pubkey::default()",
              "until init_growing_pot_obligation runs."
            ],
            "type": "pubkey"
          },
          {
            "name": "potPrincipalUsdc",
            "docs": [
              "EXACT USDC principal currently attributed to the pot position. Increased",
              "by compound_growing_pot (by the precise amount deposited) and reset to 0",
              "by harvest_growing_pot_yield (which returns the recovered principal to",
              "growing_pot_vault). Checked math ONLY — this gates the \"principal is",
              "never paid out as prize\" promise (see harvest_growing_pot_yield)."
            ],
            "type": "u64"
          },
          {
            "name": "growingPotObligationReady",
            "docs": [
              "True once init_growing_pot_obligation has run (the pot obligation exists)."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "potHarvested",
      "docs": [
        "Emitted by harvest_growing_pot_yield. `total_redeemed` is the USDC pulled out",
        "of the pot's Kamino position this harvest; `principal_returned` is the slice",
        "sent back to growing_pot_vault (to be re-compounded); `yield_amount` is the",
        "remainder left in usdc_vault — which the existing trigger_draw prize formula",
        "then captures into the weekly prize."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "totalRedeemed",
            "type": "u64"
          },
          {
            "name": "yieldAmount",
            "type": "u64"
          },
          {
            "name": "principalReturned",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "userPosition",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "docs": [
              "Wallet owner of this position."
            ],
            "type": "pubkey"
          },
          {
            "name": "amount",
            "docs": [
              "Cumulative USDC deposited (sum of all top-ups, never paid out partially)."
            ],
            "type": "u64"
          },
          {
            "name": "firstDepositTs",
            "docs": [
              "First-ever deposit timestamp (for duration-weighted entries in M4)."
            ],
            "type": "i64"
          },
          {
            "name": "lastDepositTs",
            "docs": [
              "Most recent deposit/top-up timestamp."
            ],
            "type": "i64"
          },
          {
            "name": "withdrawRequestedAt",
            "docs": [
              "0 if no pending withdraw; else timestamp of request_withdraw call."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "Stored bump for cheap re-derivation."
            ],
            "type": "u8"
          }
        ]
      }
    }
  ]
};
