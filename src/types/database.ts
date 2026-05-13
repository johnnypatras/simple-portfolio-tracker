export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      activity_log: {
        Row: {
          action: Database["public"]["Enums"]["action_type"]
          after_snapshot: Json | null
          before_snapshot: Json | null
          cashflow_amount_eur: number | null
          cashflow_amount_usd: number | null
          cashflow_asset_class: string | null
          cashflow_attempted_at: string | null
          cashflow_status: string | null
          compensates_for: string | null
          created_at: string
          delta_attempted_at: string | null
          delta_eur: number | null
          delta_status: string | null
          delta_usd: number | null
          description: string
          details: Json | null
          effective_date: string | null
          entity_id: string | null
          entity_name: string
          entity_table: string | null
          entity_type: Database["public"]["Enums"]["entity_type"]
          id: string
          is_adjustment: boolean
          split_from_id: string | null
          transfer_group_id: string | null
          undone_at: string | null
          user_id: string
        }
        Insert: {
          action: Database["public"]["Enums"]["action_type"]
          after_snapshot?: Json | null
          before_snapshot?: Json | null
          cashflow_amount_eur?: number | null
          cashflow_amount_usd?: number | null
          cashflow_asset_class?: string | null
          cashflow_attempted_at?: string | null
          cashflow_status?: string | null
          compensates_for?: string | null
          created_at?: string
          delta_attempted_at?: string | null
          delta_eur?: number | null
          delta_status?: string | null
          delta_usd?: number | null
          description: string
          details?: Json | null
          effective_date?: string | null
          entity_id?: string | null
          entity_name: string
          entity_table?: string | null
          entity_type: Database["public"]["Enums"]["entity_type"]
          id?: string
          is_adjustment?: boolean
          split_from_id?: string | null
          transfer_group_id?: string | null
          undone_at?: string | null
          user_id: string
        }
        Update: {
          action?: Database["public"]["Enums"]["action_type"]
          after_snapshot?: Json | null
          before_snapshot?: Json | null
          cashflow_amount_eur?: number | null
          cashflow_amount_usd?: number | null
          cashflow_asset_class?: string | null
          cashflow_attempted_at?: string | null
          cashflow_status?: string | null
          compensates_for?: string | null
          created_at?: string
          delta_attempted_at?: string | null
          delta_eur?: number | null
          delta_status?: string | null
          delta_usd?: number | null
          description?: string
          details?: Json | null
          effective_date?: string | null
          entity_id?: string | null
          entity_name?: string
          entity_table?: string | null
          entity_type?: Database["public"]["Enums"]["entity_type"]
          id?: string
          is_adjustment?: boolean
          split_from_id?: string | null
          transfer_group_id?: string | null
          undone_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_log_compensates_for_fkey"
            columns: ["compensates_for"]
            isOneToOne: false
            referencedRelation: "activity_log"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_log_split_from_id_fkey"
            columns: ["split_from_id"]
            isOneToOne: false
            referencedRelation: "activity_log"
            referencedColumns: ["id"]
          },
        ]
      }
      brokers: {
        Row: {
          created_at: string
          deleted_at: string | null
          id: string
          institution_id: string | null
          name: string
          user_id: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          institution_id?: string | null
          name: string
          user_id: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          institution_id?: string | null
          name?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "brokers_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
      cash_accounts: {
        Row: {
          apy: number
          balance: number
          broker_id: string | null
          created_at: string
          currency: string
          deleted_at: string | null
          id: string
          institution_id: string | null
          last_was_adjustment: boolean
          last_was_transfer: boolean
          name: string | null
          region: string | null
          updated_at: string
          user_id: string
          wallet_id: string | null
        }
        Insert: {
          apy?: number
          balance?: number
          broker_id?: string | null
          created_at?: string
          currency?: string
          deleted_at?: string | null
          id?: string
          institution_id?: string | null
          last_was_adjustment?: boolean
          last_was_transfer?: boolean
          name?: string | null
          region?: string | null
          updated_at?: string
          user_id: string
          wallet_id?: string | null
        }
        Update: {
          apy?: number
          balance?: number
          broker_id?: string | null
          created_at?: string
          currency?: string
          deleted_at?: string | null
          id?: string
          institution_id?: string | null
          last_was_adjustment?: boolean
          last_was_transfer?: boolean
          name?: string | null
          region?: string | null
          updated_at?: string
          user_id?: string
          wallet_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cash_accounts_broker_id_fkey"
            columns: ["broker_id"]
            isOneToOne: false
            referencedRelation: "brokers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_accounts_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_accounts_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["id"]
          },
        ]
      }
      cron_config: {
        Row: {
          key: string
          value: string
        }
        Insert: {
          key: string
          value: string
        }
        Update: {
          key?: string
          value?: string
        }
        Relationships: []
      }
      crypto_assets: {
        Row: {
          chain: string | null
          coingecko_id: string
          created_at: string
          deleted_at: string | null
          id: string
          image_url: string | null
          name: string
          subcategory: string | null
          ticker: string
          user_id: string
        }
        Insert: {
          chain?: string | null
          coingecko_id: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          image_url?: string | null
          name: string
          subcategory?: string | null
          ticker: string
          user_id: string
        }
        Update: {
          chain?: string | null
          coingecko_id?: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          image_url?: string | null
          name?: string
          subcategory?: string | null
          ticker?: string
          user_id?: string
        }
        Relationships: []
      }
      crypto_positions: {
        Row: {
          acquisition_method: string | null
          apy: number
          crypto_asset_id: string
          deleted_at: string | null
          id: string
          last_was_adjustment: boolean
          last_was_transfer: boolean
          network: string | null
          quantity: number | null
          updated_at: string
          wallet_id: string
        }
        Insert: {
          acquisition_method?: string | null
          apy?: number
          crypto_asset_id: string
          deleted_at?: string | null
          id?: string
          last_was_adjustment?: boolean
          last_was_transfer?: boolean
          network?: string | null
          quantity?: number | null
          updated_at?: string
          wallet_id: string
        }
        Update: {
          acquisition_method?: string | null
          apy?: number
          crypto_asset_id?: string
          deleted_at?: string | null
          id?: string
          last_was_adjustment?: boolean
          last_was_transfer?: boolean
          network?: string | null
          quantity?: number | null
          updated_at?: string
          wallet_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "crypto_positions_crypto_asset_id_fkey"
            columns: ["crypto_asset_id"]
            isOneToOne: false
            referencedRelation: "crypto_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crypto_positions_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "wallets"
            referencedColumns: ["id"]
          },
        ]
      }
      diary_entries: {
        Row: {
          content: string
          created_at: string
          deleted_at: string | null
          entry_date: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          deleted_at?: string | null
          entry_date?: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          deleted_at?: string | null
          entry_date?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      goal_prices: {
        Row: {
          crypto_asset_id: string
          deleted_at: string | null
          id: string
          label: string | null
          target_price: number
          weight: number | null
        }
        Insert: {
          crypto_asset_id: string
          deleted_at?: string | null
          id?: string
          label?: string | null
          target_price: number
          weight?: number | null
        }
        Update: {
          crypto_asset_id?: string
          deleted_at?: string | null
          id?: string
          label?: string | null
          target_price?: number
          weight?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "goal_prices_crypto_asset_id_fkey"
            columns: ["crypto_asset_id"]
            isOneToOne: false
            referencedRelation: "crypto_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      institutions: {
        Row: {
          created_at: string
          deleted_at: string | null
          id: string
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          id?: string
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      invite_codes: {
        Row: {
          code: string
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          used_at: string | null
          used_by: string | null
        }
        Insert: {
          code: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          used_at?: string | null
          used_by?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          used_at?: string | null
          used_by?: string | null
        }
        Relationships: []
      }
      manual_nav_updates: {
        Row: {
          asset_id: string
          created_at: string
          effective_date: string
          id: string
          nav: number
          note: string | null
          user_id: string
        }
        Insert: {
          asset_id: string
          created_at?: string
          effective_date: string
          id?: string
          nav: number
          note?: string | null
          user_id: string
        }
        Update: {
          asset_id?: string
          created_at?: string
          effective_date?: string
          id?: string
          nav?: number
          note?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "manual_nav_updates_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "stock_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_shares: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          label: string | null
          owner_id: string
          revoked_at: string | null
          scope: Database["public"]["Enums"]["share_scope"]
          share_type: Database["public"]["Enums"]["share_type"]
          token: string | null
          updated_at: string
          viewer_id: string | null
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          label?: string | null
          owner_id: string
          revoked_at?: string | null
          scope?: Database["public"]["Enums"]["share_scope"]
          share_type: Database["public"]["Enums"]["share_type"]
          token?: string | null
          updated_at?: string
          viewer_id?: string | null
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          label?: string | null
          owner_id?: string
          revoked_at?: string | null
          scope?: Database["public"]["Enums"]["share_scope"]
          share_type?: Database["public"]["Enums"]["share_type"]
          token?: string | null
          updated_at?: string
          viewer_id?: string | null
        }
        Relationships: []
      }
      portfolio_snapshots: {
        Row: {
          cash_eur_denominated_value: number | null
          cash_value_eur: number | null
          cash_value_usd: number | null
          created_at: string
          crypto_value_eur: number | null
          crypto_value_usd: number | null
          id: string
          snapshot_date: string
          stocks_eur_denominated_value: number | null
          stocks_value_eur: number | null
          stocks_value_usd: number | null
          total_value_eur: number | null
          total_value_usd: number | null
          user_id: string
        }
        Insert: {
          cash_eur_denominated_value?: number | null
          cash_value_eur?: number | null
          cash_value_usd?: number | null
          created_at?: string
          crypto_value_eur?: number | null
          crypto_value_usd?: number | null
          id?: string
          snapshot_date?: string
          stocks_eur_denominated_value?: number | null
          stocks_value_eur?: number | null
          stocks_value_usd?: number | null
          total_value_eur?: number | null
          total_value_usd?: number | null
          user_id: string
        }
        Update: {
          cash_eur_denominated_value?: number | null
          cash_value_eur?: number | null
          cash_value_usd?: number | null
          created_at?: string
          crypto_value_eur?: number | null
          crypto_value_usd?: number | null
          id?: string
          snapshot_date?: string
          stocks_eur_denominated_value?: number | null
          stocks_value_eur?: number | null
          stocks_value_usd?: number | null
          total_value_eur?: number | null
          total_value_usd?: number | null
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          email: string
          first_name: string | null
          id: string
          last_name: string | null
          primary_currency: Database["public"]["Enums"]["currency_type"]
          role: string
          status: string
          theme: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email: string
          first_name?: string | null
          id: string
          last_name?: string | null
          primary_currency?: Database["public"]["Enums"]["currency_type"]
          role?: string
          status?: string
          theme?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string
          first_name?: string | null
          id?: string
          last_name?: string | null
          primary_currency?: Database["public"]["Enums"]["currency_type"]
          role?: string
          status?: string
          theme?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      stock_assets: {
        Row: {
          category: Database["public"]["Enums"]["asset_category"] | null
          created_at: string
          currency: string
          deleted_at: string | null
          id: string
          isin: string | null
          kind: string
          name: string
          subcategory: string | null
          tags: string[]
          ticker: string
          user_id: string
          yahoo_ticker: string | null
        }
        Insert: {
          category?: Database["public"]["Enums"]["asset_category"] | null
          created_at?: string
          currency?: string
          deleted_at?: string | null
          id?: string
          isin?: string | null
          kind?: string
          name: string
          subcategory?: string | null
          tags?: string[]
          ticker: string
          user_id: string
          yahoo_ticker?: string | null
        }
        Update: {
          category?: Database["public"]["Enums"]["asset_category"] | null
          created_at?: string
          currency?: string
          deleted_at?: string | null
          id?: string
          isin?: string | null
          kind?: string
          name?: string
          subcategory?: string | null
          tags?: string[]
          ticker?: string
          user_id?: string
          yahoo_ticker?: string | null
        }
        Relationships: []
      }
      stock_positions: {
        Row: {
          broker_id: string
          deleted_at: string | null
          id: string
          last_was_adjustment: boolean
          last_was_transfer: boolean
          quantity: number | null
          stock_asset_id: string
          updated_at: string
        }
        Insert: {
          broker_id: string
          deleted_at?: string | null
          id?: string
          last_was_adjustment?: boolean
          last_was_transfer?: boolean
          quantity?: number | null
          stock_asset_id: string
          updated_at?: string
        }
        Update: {
          broker_id?: string
          deleted_at?: string | null
          id?: string
          last_was_adjustment?: boolean
          last_was_transfer?: boolean
          quantity?: number | null
          stock_asset_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_positions_broker_id_fkey"
            columns: ["broker_id"]
            isOneToOne: false
            referencedRelation: "brokers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_positions_stock_asset_id_fkey"
            columns: ["stock_asset_id"]
            isOneToOne: false
            referencedRelation: "stock_assets"
            referencedColumns: ["id"]
          },
        ]
      }
      trade_entries: {
        Row: {
          action: string
          asset_name: string
          asset_type: string
          created_at: string
          currency: string
          deleted_at: string | null
          id: string
          notes: string | null
          price: number
          quantity: number
          total_value: number
          trade_date: string
          updated_at: string
          user_id: string
        }
        Insert: {
          action: string
          asset_name: string
          asset_type: string
          created_at?: string
          currency?: string
          deleted_at?: string | null
          id?: string
          notes?: string | null
          price: number
          quantity: number
          total_value: number
          trade_date?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          action?: string
          asset_name?: string
          asset_type?: string
          created_at?: string
          currency?: string
          deleted_at?: string | null
          id?: string
          notes?: string | null
          price?: number
          quantity?: number
          total_value?: number
          trade_date?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      wallets: {
        Row: {
          chain: string | null
          created_at: string
          deleted_at: string | null
          id: string
          institution_id: string | null
          name: string
          privacy_label: Database["public"]["Enums"]["privacy_label"] | null
          user_id: string
          wallet_type: Database["public"]["Enums"]["wallet_type"]
        }
        Insert: {
          chain?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          institution_id?: string | null
          name: string
          privacy_label?: Database["public"]["Enums"]["privacy_label"] | null
          user_id: string
          wallet_type: Database["public"]["Enums"]["wallet_type"]
        }
        Update: {
          chain?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          institution_id?: string | null
          name?: string
          privacy_label?: Database["public"]["Enums"]["privacy_label"] | null
          user_id?: string
          wallet_type?: Database["public"]["Enums"]["wallet_type"]
        }
        Relationships: [
          {
            foreignKeyName: "wallets_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      call_daily_snapshot: { Args: never; Returns: undefined }
      get_latest_manual_navs_at: {
        Args: { p_as_of: string; p_user_id?: string }
        Returns: {
          asset_id: string
          effective_date: string
          nav: number
          note: string
        }[]
      }
      is_active_user: { Args: never; Returns: boolean }
    }
    Enums: {
      action_type: "created" | "updated" | "removed" | "undone"
      asset_category:
        | "stock"
        | "etf_non_ucits"
        | "etf_ucits"
        | "bond"
        | "other"
        | "individual_stock"
        | "etf"
        | "bond_fixed_income"
        | "private_equity"
      currency_type: "USD" | "EUR"
      entity_type:
        | "crypto_asset"
        | "stock_asset"
        | "wallet"
        | "broker"
        | "bank_account"
        | "exchange_deposit"
        | "crypto_position"
        | "stock_position"
        | "diary_entry"
        | "goal_price"
        | "trade_entry"
        | "broker_deposit"
        | "institution"
        | "cash_account"
        | "manual_nav_update"
      privacy_label: "anon" | "doxxed"
      share_scope: "overview" | "full" | "full_with_history"
      share_type: "link" | "user"
      wallet_type: "custodial" | "non_custodial"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      action_type: ["created", "updated", "removed", "undone"],
      asset_category: [
        "stock",
        "etf_non_ucits",
        "etf_ucits",
        "bond",
        "other",
        "individual_stock",
        "etf",
        "bond_fixed_income",
        "private_equity",
      ],
      currency_type: ["USD", "EUR"],
      entity_type: [
        "crypto_asset",
        "stock_asset",
        "wallet",
        "broker",
        "bank_account",
        "exchange_deposit",
        "crypto_position",
        "stock_position",
        "diary_entry",
        "goal_price",
        "trade_entry",
        "broker_deposit",
        "institution",
        "cash_account",
        "manual_nav_update",
      ],
      privacy_label: ["anon", "doxxed"],
      share_scope: ["overview", "full", "full_with_history"],
      share_type: ["link", "user"],
      wallet_type: ["custodial", "non_custodial"],
    },
  },
} as const

