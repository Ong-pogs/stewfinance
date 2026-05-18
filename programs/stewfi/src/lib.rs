use anchor_lang::prelude::*;

declare_id!("8uDmfYPMBaiLLwfZGAnhNaDm48kx19hD8kPdiR7XiRLD");

#[program]
pub mod stewfi {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
