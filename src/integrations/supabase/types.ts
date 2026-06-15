export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      access_requests: {
        Row: {
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision_notes: string | null
          email: string
          full_name: string
          id: string
          message: string | null
          status: Database["public"]["Enums"]["access_request_status"]
        }
        Insert: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_notes?: string | null
          email: string
          full_name: string
          id?: string
          message?: string | null
          status?: Database["public"]["Enums"]["access_request_status"]
        }
        Update: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_notes?: string | null
          email?: string
          full_name?: string
          id?: string
          message?: string | null
          status?: Database["public"]["Enums"]["access_request_status"]
        }
        Relationships: []
      }
      ai_conversations: {
        Row: {
          created_at: string
          id: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_messages: {
        Row: {
          conversation_id: string
          created_at: string
          id: string
          parts: Json
          role: Database["public"]["Enums"]["chat_role"]
          user_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          id?: string
          parts: Json
          role: Database["public"]["Enums"]["chat_role"]
          user_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          id?: string
          parts?: Json
          role?: Database["public"]["Enums"]["chat_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "ai_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_assistant_memories: {
        Row: {
          content: string
          created_at: string
          created_by: string | null
          id: string
          kind: string
          tags: string[]
          updated_at: string
        }
        Insert: {
          content: string
          created_at?: string
          created_by?: string | null
          id?: string
          kind: string
          tags?: string[]
          updated_at?: string
        }
        Update: {
          content?: string
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
          tags?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      clwrota_sync_metrics: {
        Row: {
          chunks_fell_back_to_per_row: number
          chunks_succeeded_after_retry: number
          chunks_succeeded_first_try: number
          chunks_total: number
          duration_ms: number | null
          errors_count: number
          id: string
          is_backfill: boolean
          non_working_cleaned: number
          notes: string | null
          ok: boolean
          per_row_attempts: number
          per_row_failed: number
          per_row_succeeded: number
          rows_deleted: number
          rows_drafted: number
          rows_failed: number
          rows_pulled: number
          rows_skipped_validation: number
          rows_upserted: number
          run_at: string
          sync_kind: string
          upsert_attempts_total: number
          upsert_retries_total: number
        }
        Insert: {
          chunks_fell_back_to_per_row?: number
          chunks_succeeded_after_retry?: number
          chunks_succeeded_first_try?: number
          chunks_total?: number
          duration_ms?: number | null
          errors_count?: number
          id?: string
          is_backfill?: boolean
          non_working_cleaned?: number
          notes?: string | null
          ok: boolean
          per_row_attempts?: number
          per_row_failed?: number
          per_row_succeeded?: number
          rows_deleted?: number
          rows_drafted?: number
          rows_failed?: number
          rows_pulled?: number
          rows_skipped_validation?: number
          rows_upserted?: number
          run_at?: string
          sync_kind: string
          upsert_attempts_total?: number
          upsert_retries_total?: number
        }
        Update: {
          chunks_fell_back_to_per_row?: number
          chunks_succeeded_after_retry?: number
          chunks_succeeded_first_try?: number
          chunks_total?: number
          duration_ms?: number | null
          errors_count?: number
          id?: string
          is_backfill?: boolean
          non_working_cleaned?: number
          notes?: string | null
          ok?: boolean
          per_row_attempts?: number
          per_row_failed?: number
          per_row_succeeded?: number
          rows_deleted?: number
          rows_drafted?: number
          rows_failed?: number
          rows_pulled?: number
          rows_skipped_validation?: number
          rows_upserted?: number
          run_at?: string
          sync_kind?: string
          upsert_attempts_total?: number
          upsert_retries_total?: number
        }
        Relationships: []
      }
      clwrota_sync_state: {
        Row: {
          auto_reclassify_trainee_solo: boolean
          id: number
          incremental_days_ahead: number
          incremental_days_back: number
          last_error: string | null
          last_pulled_rows: number | null
          last_status: string | null
          last_successful_rota_sync_at: string | null
          last_sync_at: string | null
          leave_report_url: string | null
          rota_report_url: string | null
          staff_report_url: string | null
          sync_days_ahead: number
          sync_days_back: number
        }
        Insert: {
          auto_reclassify_trainee_solo?: boolean
          id?: number
          incremental_days_ahead?: number
          incremental_days_back?: number
          last_error?: string | null
          last_pulled_rows?: number | null
          last_status?: string | null
          last_successful_rota_sync_at?: string | null
          last_sync_at?: string | null
          leave_report_url?: string | null
          rota_report_url?: string | null
          staff_report_url?: string | null
          sync_days_ahead?: number
          sync_days_back?: number
        }
        Update: {
          auto_reclassify_trainee_solo?: boolean
          id?: number
          incremental_days_ahead?: number
          incremental_days_back?: number
          last_error?: string | null
          last_pulled_rows?: number | null
          last_status?: string | null
          last_successful_rota_sync_at?: string | null
          last_sync_at?: string | null
          leave_report_url?: string | null
          rota_report_url?: string | null
          staff_report_url?: string | null
          sync_days_ahead?: number
          sync_days_back?: number
        }
        Relationships: []
      }
      custom_rota_rules: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          grade: string | null
          id: string
          rule_text: string
          scope: Database["public"]["Enums"]["custom_rule_scope"]
          staff_id: string | null
          summary: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          grade?: string | null
          id?: string
          rule_text: string
          scope?: Database["public"]["Enums"]["custom_rule_scope"]
          staff_id?: string | null
          summary: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          grade?: string | null
          id?: string
          rule_text?: string
          scope?: Database["public"]["Enums"]["custom_rule_scope"]
          staff_id?: string | null
          summary?: string
          updated_at?: string
        }
        Relationships: []
      }
      duty_type_mappings: {
        Row: {
          active: boolean
          created_at: string
          duty_type: Database["public"]["Enums"]["duty_type"]
          grade_filter: string | null
          id: string
          match_type: string
          notes: string | null
          pattern: string
          priority: number
          trainee_seniority_filter: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          duty_type: Database["public"]["Enums"]["duty_type"]
          grade_filter?: string | null
          id?: string
          match_type?: string
          notes?: string | null
          pattern: string
          priority?: number
          trainee_seniority_filter?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          duty_type?: Database["public"]["Enums"]["duty_type"]
          grade_filter?: string | null
          id?: string
          match_type?: string
          notes?: string | null
          pattern?: string
          priority?: number
          trainee_seniority_filter?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      duty_type_pool_rules: {
        Row: {
          category: string
          created_at: string
          duty_type: Database["public"]["Enums"]["duty_type"]
          notes: string | null
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          duty_type: Database["public"]["Enums"]["duty_type"]
          notes?: string | null
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          duty_type?: Database["public"]["Enums"]["duty_type"]
          notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      email_inbound_log: {
        Row: {
          body_text: string | null
          error: string | null
          from_email: string
          id: string
          matched_user_id: string | null
          received_at: string
          reply_text: string | null
          status: string
          subject: string | null
        }
        Insert: {
          body_text?: string | null
          error?: string | null
          from_email: string
          id?: string
          matched_user_id?: string | null
          received_at?: string
          reply_text?: string | null
          status?: string
          subject?: string | null
        }
        Update: {
          body_text?: string | null
          error?: string | null
          from_email?: string
          id?: string
          matched_user_id?: string | null
          received_at?: string
          reply_text?: string | null
          status?: string
          subject?: string | null
        }
        Relationships: []
      }
      fixed_sessions: {
        Row: {
          created_at: string
          day_of_week: number
          description: string | null
          id: string
          session: Database["public"]["Enums"]["session_half"]
          staff_id: string
          theatre_id: string | null
        }
        Insert: {
          created_at?: string
          day_of_week: number
          description?: string | null
          id?: string
          session: Database["public"]["Enums"]["session_half"]
          staff_id: string
          theatre_id?: string | null
        }
        Update: {
          created_at?: string
          day_of_week?: number
          description?: string | null
          id?: string
          session?: Database["public"]["Enums"]["session_half"]
          staff_id?: string
          theatre_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fixed_sessions_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_sessions_theatre_fk"
            columns: ["theatre_id"]
            isOneToOne: false
            referencedRelation: "theatres"
            referencedColumns: ["id"]
          },
        ]
      }
      job_plans: {
        Row: {
          created_at: string
          dcc_pas: number
          id: string
          ltft: boolean
          ltft_percentage: number | null
          notes: string | null
          on_call_commitment: string | null
          spa_pas: number
          staff_id: string
          total_pas: number
          updated_at: string
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          created_at?: string
          dcc_pas?: number
          id?: string
          ltft?: boolean
          ltft_percentage?: number | null
          notes?: string | null
          on_call_commitment?: string | null
          spa_pas?: number
          staff_id: string
          total_pas?: number
          updated_at?: string
          valid_from?: string
          valid_to?: string | null
        }
        Update: {
          created_at?: string
          dcc_pas?: number
          id?: string
          ltft?: boolean
          ltft_percentage?: number | null
          notes?: string | null
          on_call_commitment?: string | null
          spa_pas?: number
          staff_id?: string
          total_pas?: number
          updated_at?: string
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_plans_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      leave_allowances: {
        Row: {
          annual_days: number
          created_at: string
          id: string
          leave_year_start: string
          professional_days: number
          staff_id: string
          study_days: number
          updated_at: string
        }
        Insert: {
          annual_days?: number
          created_at?: string
          id?: string
          leave_year_start: string
          professional_days?: number
          staff_id: string
          study_days?: number
          updated_at?: string
        }
        Update: {
          annual_days?: number
          created_at?: string
          id?: string
          leave_year_start?: string
          professional_days?: number
          staff_id?: string
          study_days?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "leave_allowances_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      leave_requests: {
        Row: {
          clwrota_external_id: string | null
          conflict_notes: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision_notes: string | null
          end_date: string
          half_day_end: Database["public"]["Enums"]["session_half"] | null
          half_day_start: Database["public"]["Enums"]["session_half"] | null
          id: string
          reason: string | null
          reserve_listed_at: string | null
          staff_id: string
          start_date: string
          status: Database["public"]["Enums"]["leave_status"]
          type: Database["public"]["Enums"]["leave_type"]
          updated_at: string
        }
        Insert: {
          clwrota_external_id?: string | null
          conflict_notes?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_notes?: string | null
          end_date: string
          half_day_end?: Database["public"]["Enums"]["session_half"] | null
          half_day_start?: Database["public"]["Enums"]["session_half"] | null
          id?: string
          reason?: string | null
          reserve_listed_at?: string | null
          staff_id: string
          start_date: string
          status?: Database["public"]["Enums"]["leave_status"]
          type: Database["public"]["Enums"]["leave_type"]
          updated_at?: string
        }
        Update: {
          clwrota_external_id?: string | null
          conflict_notes?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_notes?: string | null
          end_date?: string
          half_day_end?: Database["public"]["Enums"]["session_half"] | null
          half_day_start?: Database["public"]["Enums"]["session_half"] | null
          id?: string
          reason?: string | null
          reserve_listed_at?: string | null
          staff_id?: string
          start_date?: string
          status?: Database["public"]["Enums"]["leave_status"]
          type?: Database["public"]["Enums"]["leave_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "leave_requests_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          active: boolean
          clwrota_external_id: string | null
          created_at: string
          email: string
          full_name: string
          gmc_number: string | null
          grade: Database["public"]["Enums"]["staff_grade"] | null
          id: string
          left_at: string | null
          ltft_days_off: number[]
          rotation_end_date: string | null
          start_date: string | null
          training_level: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          clwrota_external_id?: string | null
          created_at?: string
          email: string
          full_name?: string
          gmc_number?: string | null
          grade?: Database["public"]["Enums"]["staff_grade"] | null
          id: string
          left_at?: string | null
          ltft_days_off?: number[]
          rotation_end_date?: string | null
          start_date?: string | null
          training_level?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          clwrota_external_id?: string | null
          created_at?: string
          email?: string
          full_name?: string
          gmc_number?: string | null
          grade?: Database["public"]["Enums"]["staff_grade"] | null
          id?: string
          left_at?: string | null
          ltft_days_off?: number[]
          rotation_end_date?: string | null
          start_date?: string | null
          training_level?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      rota_assignments: {
        Row: {
          clwrota_external_id: string | null
          created_at: string
          duty_type: Database["public"]["Enums"]["duty_type"]
          id: string
          is_non_sag: boolean
          locally_modified: boolean
          notes: string | null
          role_on_list: Database["public"]["Enums"]["rota_role"]
          session: Database["public"]["Enums"]["session_half"]
          session_date: string
          source: Database["public"]["Enums"]["rota_source"]
          staff_id: string
          supervisor_id: string | null
          theatre_session_id: string | null
          updated_at: string
        }
        Insert: {
          clwrota_external_id?: string | null
          created_at?: string
          duty_type?: Database["public"]["Enums"]["duty_type"]
          id?: string
          is_non_sag?: boolean
          locally_modified?: boolean
          notes?: string | null
          role_on_list?: Database["public"]["Enums"]["rota_role"]
          session: Database["public"]["Enums"]["session_half"]
          session_date: string
          source?: Database["public"]["Enums"]["rota_source"]
          staff_id: string
          supervisor_id?: string | null
          theatre_session_id?: string | null
          updated_at?: string
        }
        Update: {
          clwrota_external_id?: string | null
          created_at?: string
          duty_type?: Database["public"]["Enums"]["duty_type"]
          id?: string
          is_non_sag?: boolean
          locally_modified?: boolean
          notes?: string | null
          role_on_list?: Database["public"]["Enums"]["rota_role"]
          session?: Database["public"]["Enums"]["session_half"]
          session_date?: string
          source?: Database["public"]["Enums"]["rota_source"]
          staff_id?: string
          supervisor_id?: string | null
          theatre_session_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rota_assignments_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rota_assignments_supervisor_id_fkey"
            columns: ["supervisor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rota_assignments_theatre_session_id_fkey"
            columns: ["theatre_session_id"]
            isOneToOne: false
            referencedRelation: "theatre_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      rota_change_log: {
        Row: {
          action: string
          assignment_id: string | null
          changed_at: string
          changed_by: string | null
          hours_before_session: number
          id: string
          session: Database["public"]["Enums"]["session_half"]
          session_date: string
          session_start_ts: string
          staff_id: string | null
        }
        Insert: {
          action: string
          assignment_id?: string | null
          changed_at?: string
          changed_by?: string | null
          hours_before_session: number
          id?: string
          session: Database["public"]["Enums"]["session_half"]
          session_date: string
          session_start_ts: string
          staff_id?: string | null
        }
        Update: {
          action?: string
          assignment_id?: string | null
          changed_at?: string
          changed_by?: string | null
          hours_before_session?: number
          id?: string
          session?: Database["public"]["Enums"]["session_half"]
          session_date?: string
          session_start_ts?: string
          staff_id?: string | null
        }
        Relationships: []
      }
      rota_reclassification_log: {
        Row: {
          assignment_id: string
          created_at: string
          from_role: Database["public"]["Enums"]["rota_role"]
          id: string
          reason: string | null
          sync_run_id: string
          to_role: Database["public"]["Enums"]["rota_role"]
        }
        Insert: {
          assignment_id: string
          created_at?: string
          from_role: Database["public"]["Enums"]["rota_role"]
          id?: string
          reason?: string | null
          sync_run_id: string
          to_role: Database["public"]["Enums"]["rota_role"]
        }
        Update: {
          assignment_id?: string
          created_at?: string
          from_role?: Database["public"]["Enums"]["rota_role"]
          id?: string
          reason?: string | null
          sync_run_id?: string
          to_role?: Database["public"]["Enums"]["rota_role"]
        }
        Relationships: []
      }
      rota_rules: {
        Row: {
          allow_back_to_back_oncall: boolean
          default_dcc_pas: number
          default_spa_pas: number
          default_total_pas: number
          honour_fixed_sessions: boolean
          id: number
          ltft_round_to: number
          max_consecutive_days: number
          max_sessions_per_week: number
          min_rest_hours: number
          notes: string | null
          oncall_pa_credit: number
          post_nights_off_days: number
          sessions_per_pa: number
          trainee_at_risk_pct: number
          trainee_behind_pct: number
          updated_at: string
          updated_by: string | null
          weekend_pa_credit: number
        }
        Insert: {
          allow_back_to_back_oncall?: boolean
          default_dcc_pas?: number
          default_spa_pas?: number
          default_total_pas?: number
          honour_fixed_sessions?: boolean
          id?: number
          ltft_round_to?: number
          max_consecutive_days?: number
          max_sessions_per_week?: number
          min_rest_hours?: number
          notes?: string | null
          oncall_pa_credit?: number
          post_nights_off_days?: number
          sessions_per_pa?: number
          trainee_at_risk_pct?: number
          trainee_behind_pct?: number
          updated_at?: string
          updated_by?: string | null
          weekend_pa_credit?: number
        }
        Update: {
          allow_back_to_back_oncall?: boolean
          default_dcc_pas?: number
          default_spa_pas?: number
          default_total_pas?: number
          honour_fixed_sessions?: boolean
          id?: number
          ltft_round_to?: number
          max_consecutive_days?: number
          max_sessions_per_week?: number
          min_rest_hours?: number
          notes?: string | null
          oncall_pa_credit?: number
          post_nights_off_days?: number
          sessions_per_pa?: number
          trainee_at_risk_pct?: number
          trainee_behind_pct?: number
          updated_at?: string
          updated_by?: string | null
          weekend_pa_credit?: number
        }
        Relationships: []
      }
      specialties: {
        Row: {
          created_at: string
          id: string
          is_trainee_bucket: boolean
          name: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_trainee_bucket?: boolean
          name: string
        }
        Update: {
          created_at?: string
          id?: string
          is_trainee_bucket?: boolean
          name?: string
        }
        Relationships: []
      }
      theatre_name_aliases: {
        Row: {
          active: boolean
          alias: string
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          theatre_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          alias: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          theatre_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          alias?: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          theatre_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "theatre_name_aliases_theatre_id_fkey"
            columns: ["theatre_id"]
            isOneToOne: false
            referencedRelation: "theatres"
            referencedColumns: ["id"]
          },
        ]
      }
      theatre_sessions: {
        Row: {
          clwrota_external_id: string | null
          created_at: string
          id: string
          is_non_sag: boolean
          non_sag_override: boolean
          notes: string | null
          session: Database["public"]["Enums"]["session_half"]
          session_date: string
          specialty_id: string | null
          surgical_consultant: string | null
          theatre_id: string
          updated_at: string
        }
        Insert: {
          clwrota_external_id?: string | null
          created_at?: string
          id?: string
          is_non_sag?: boolean
          non_sag_override?: boolean
          notes?: string | null
          session: Database["public"]["Enums"]["session_half"]
          session_date: string
          specialty_id?: string | null
          surgical_consultant?: string | null
          theatre_id: string
          updated_at?: string
        }
        Update: {
          clwrota_external_id?: string | null
          created_at?: string
          id?: string
          is_non_sag?: boolean
          non_sag_override?: boolean
          notes?: string | null
          session?: Database["public"]["Enums"]["session_half"]
          session_date?: string
          specialty_id?: string | null
          surgical_consultant?: string | null
          theatre_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "theatre_sessions_specialty_id_fkey"
            columns: ["specialty_id"]
            isOneToOne: false
            referencedRelation: "specialties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "theatre_sessions_theatre_id_fkey"
            columns: ["theatre_id"]
            isOneToOne: false
            referencedRelation: "theatres"
            referencedColumns: ["id"]
          },
        ]
      }
      theatres: {
        Row: {
          active: boolean
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["theatre_kind"]
          name: string
          sort_order: number
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          kind: Database["public"]["Enums"]["theatre_kind"]
          name: string
          sort_order?: number
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["theatre_kind"]
          name?: string
          sort_order?: number
        }
        Relationships: []
      }
      trainee_targets: {
        Row: {
          created_at: string
          id: string
          notes: string | null
          required_sessions: number
          required_solo: number
          required_supervised: number
          specialty_id: string
          training_level: string
        }
        Insert: {
          created_at?: string
          id?: string
          notes?: string | null
          required_sessions?: number
          required_solo?: number
          required_supervised?: number
          specialty_id: string
          training_level: string
        }
        Update: {
          created_at?: string
          id?: string
          notes?: string | null
          required_sessions?: number
          required_solo?: number
          required_supervised?: number
          specialty_id?: string
          training_level?: string
        }
        Relationships: [
          {
            foreignKeyName: "trainee_targets_specialty_id_fkey"
            columns: ["specialty_id"]
            isOneToOne: false
            referencedRelation: "specialties"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      validation_custom_non_working_labels: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          source: string | null
          token: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          source?: string | null
          token: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          source?: string | null
          token?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      admin_run_readonly_sql: { Args: { p_query: string }; Returns: Json }
      current_user_is_coordinator_or_admin: { Args: never; Returns: boolean }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      mark_departed_trainees: {
        Args: never
        Returns: {
          left_at: string
          staff_id: string
        }[]
      }
      session_start_ts: {
        Args: {
          p_date: string
          p_session: Database["public"]["Enums"]["session_half"]
        }
        Returns: string
      }
      trigger_clwrota_sync: { Args: { p_step: string }; Returns: number }
      trigger_clwrota_sync_with_query: {
        Args: { p_query?: string; p_step: string }
        Returns: number
      }
      upsert_vault_secret: {
        Args: { p_description?: string; p_name: string; p_secret: string }
        Returns: string
      }
    }
    Enums: {
      access_request_status: "pending" | "approved" | "declined"
      app_role: "admin" | "rota_coordinator" | "staff"
      chat_role: "user" | "assistant" | "system"
      custom_rule_scope: "staff" | "grade" | "department"
      duty_type:
        | "theatre"
        | "consultant_in_charge"
        | "obstetrics"
        | "obstetrics_2nd"
        | "icu_trainee"
        | "icu_ct2_plus"
        | "icu_consultant_oncall"
        | "general_consultant_oncall"
        | "registrar_oncall"
        | "sho_oncall"
        | "spa"
        | "admin"
        | "teaching"
        | "non_clinical"
        | "nhh_oncall"
      leave_status: "pending" | "approved" | "rejected" | "cancelled"
      leave_type:
        | "annual"
        | "study"
        | "compassionate"
        | "sick"
        | "parental"
        | "other"
        | "professional"
      rota_role:
        | "solo"
        | "supervised"
        | "supervising"
        | "on_call"
        | "non_clinical"
        | "teaching"
        | "admin_session"
      rota_source: "manual" | "clwrota"
      session_half: "am" | "pm" | "eve" | "night"
      staff_grade: "consultant" | "sas" | "trainee"
      theatre_kind: "main" | "day_surgery" | "private"
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
  public: {
    Enums: {
      access_request_status: ["pending", "approved", "declined"],
      app_role: ["admin", "rota_coordinator", "staff"],
      chat_role: ["user", "assistant", "system"],
      custom_rule_scope: ["staff", "grade", "department"],
      duty_type: [
        "theatre",
        "consultant_in_charge",
        "obstetrics",
        "obstetrics_2nd",
        "icu_trainee",
        "icu_ct2_plus",
        "icu_consultant_oncall",
        "general_consultant_oncall",
        "registrar_oncall",
        "sho_oncall",
        "spa",
        "admin",
        "teaching",
        "non_clinical",
        "nhh_oncall",
      ],
      leave_status: ["pending", "approved", "rejected", "cancelled"],
      leave_type: [
        "annual",
        "study",
        "compassionate",
        "sick",
        "parental",
        "other",
        "professional",
      ],
      rota_role: [
        "solo",
        "supervised",
        "supervising",
        "on_call",
        "non_clinical",
        "teaching",
        "admin_session",
      ],
      rota_source: ["manual", "clwrota"],
      session_half: ["am", "pm", "eve", "night"],
      staff_grade: ["consultant", "sas", "trainee"],
      theatre_kind: ["main", "day_surgery", "private"],
    },
  },
} as const
