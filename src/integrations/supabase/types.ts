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
          email_enc: string | null
          email_hash: string | null
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
          email_enc?: string | null
          email_hash?: string | null
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
          email_enc?: string | null
          email_hash?: string | null
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
          parts_enc: string | null
          role: Database["public"]["Enums"]["chat_role"]
          user_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          id?: string
          parts: Json
          parts_enc?: string | null
          role: Database["public"]["Enums"]["chat_role"]
          user_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          id?: string
          parts?: Json
          parts_enc?: string | null
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
      arcp_progress: {
        Row: {
          arcp_date: string | null
          created_at: string
          current_value: number
          id: string
          last_reviewed_at: string | null
          notes: string | null
          requirement_id: string
          trainee_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          arcp_date?: string | null
          created_at?: string
          current_value?: number
          id?: string
          last_reviewed_at?: string | null
          notes?: string | null
          requirement_id: string
          trainee_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          arcp_date?: string | null
          created_at?: string
          current_value?: number
          id?: string
          last_reviewed_at?: string | null
          notes?: string | null
          requirement_id?: string
          trainee_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "arcp_progress_requirement_id_fkey"
            columns: ["requirement_id"]
            isOneToOne: false
            referencedRelation: "arcp_requirements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "arcp_progress_trainee_id_fkey"
            columns: ["trainee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "arcp_progress_trainee_id_fkey"
            columns: ["trainee_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "arcp_progress_trainee_id_fkey"
            columns: ["trainee_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "arcp_progress_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "arcp_progress_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "arcp_progress_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
        ]
      }
      arcp_requirements: {
        Row: {
          active: boolean
          category: string
          code: string
          created_at: string
          description: string | null
          id: string
          label: string
          sort_order: number
          target_value: number
          training_level: string
          unit: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          category?: string
          code: string
          created_at?: string
          description?: string | null
          id?: string
          label: string
          sort_order?: number
          target_value?: number
          training_level: string
          unit?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          category?: string
          code?: string
          created_at?: string
          description?: string | null
          id?: string
          label?: string
          sort_order?: number
          target_value?: number
          training_level?: string
          unit?: string
          updated_at?: string
        }
        Relationships: []
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
      clwrota_sync_rate_limit: {
        Row: {
          last_attempt_at: string | null
          last_request_id: number | null
          min_interval_seconds: number
          step: string
          updated_at: string
        }
        Insert: {
          last_attempt_at?: string | null
          last_request_id?: number | null
          min_interval_seconds?: number
          step: string
          updated_at?: string
        }
        Update: {
          last_attempt_at?: string | null
          last_request_id?: number | null
          min_interval_seconds?: number
          step?: string
          updated_at?: string
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
      competencies: {
        Row: {
          active: boolean
          applies_to_grades: string[]
          category: string
          code: string
          created_at: string
          description: string | null
          id: string
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          applies_to_grades?: string[]
          category: string
          code: string
          created_at?: string
          description?: string | null
          id?: string
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          applies_to_grades?: string[]
          category?: string
          code?: string
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          sort_order?: number
          updated_at?: string
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
      educational_supervisor_assignments: {
        Row: {
          created_at: string
          id: string
          notes: string | null
          supervisor_id: string
          trainee_id: string
          updated_at: string
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          notes?: string | null
          supervisor_id: string
          trainee_id: string
          updated_at?: string
          valid_from: string
          valid_to?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          notes?: string | null
          supervisor_id?: string
          trainee_id?: string
          updated_at?: string
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "educational_supervisor_assignments_supervisor_id_fkey"
            columns: ["supervisor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "educational_supervisor_assignments_supervisor_id_fkey"
            columns: ["supervisor_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "educational_supervisor_assignments_supervisor_id_fkey"
            columns: ["supervisor_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "educational_supervisor_assignments_trainee_id_fkey"
            columns: ["trainee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "educational_supervisor_assignments_trainee_id_fkey"
            columns: ["trainee_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "educational_supervisor_assignments_trainee_id_fkey"
            columns: ["trainee_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
        ]
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
      exception_report_comments: {
        Row: {
          author_id: string
          body: string
          created_at: string
          id: string
          report_id: string
        }
        Insert: {
          author_id: string
          body: string
          created_at?: string
          id?: string
          report_id: string
        }
        Update: {
          author_id?: string
          body?: string
          created_at?: string
          id?: string
          report_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "exception_report_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exception_report_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exception_report_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exception_report_comments_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "exception_reports"
            referencedColumns: ["id"]
          },
        ]
      }
      exception_reports: {
        Row: {
          acknowledged_at: string | null
          category: string
          created_at: string
          description: string
          due_by: string
          event_date: string
          event_session: Database["public"]["Enums"]["session_half"] | null
          hours_worked_extra: number | null
          id: string
          immediate_safety_concern: boolean
          outcome: string | null
          outcome_note: string | null
          resolved_at: string | null
          responder_id: string | null
          rest_missed_hours: number | null
          status: string
          trainee_id: string
          updated_at: string
        }
        Insert: {
          acknowledged_at?: string | null
          category: string
          created_at?: string
          description: string
          due_by: string
          event_date: string
          event_session?: Database["public"]["Enums"]["session_half"] | null
          hours_worked_extra?: number | null
          id?: string
          immediate_safety_concern?: boolean
          outcome?: string | null
          outcome_note?: string | null
          resolved_at?: string | null
          responder_id?: string | null
          rest_missed_hours?: number | null
          status?: string
          trainee_id: string
          updated_at?: string
        }
        Update: {
          acknowledged_at?: string | null
          category?: string
          created_at?: string
          description?: string
          due_by?: string
          event_date?: string
          event_session?: Database["public"]["Enums"]["session_half"] | null
          hours_worked_extra?: number | null
          id?: string
          immediate_safety_concern?: boolean
          outcome?: string | null
          outcome_note?: string | null
          resolved_at?: string | null
          responder_id?: string | null
          rest_missed_hours?: number | null
          status?: string
          trainee_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "exception_reports_responder_id_fkey"
            columns: ["responder_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exception_reports_responder_id_fkey"
            columns: ["responder_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exception_reports_responder_id_fkey"
            columns: ["responder_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exception_reports_trainee_id_fkey"
            columns: ["trainee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exception_reports_trainee_id_fkey"
            columns: ["trainee_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exception_reports_trainee_id_fkey"
            columns: ["trainee_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
        ]
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
            foreignKeyName: "fixed_sessions_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_sessions_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
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
      icu_detection_matches: {
        Row: {
          assignment_id: string | null
          attending_consultant_ids: string[]
          clwrota_external_id: string | null
          created_at: string
          detected_at: string
          detected_by: string
          duty_type: Database["public"]["Enums"]["duty_type"] | null
          id: string
          matched_field: string | null
          matched_value: string | null
          pa_credit: number | null
          person_label: string | null
          place_name: string | null
          role_label: string | null
          session: Database["public"]["Enums"]["session_half"]
          session_date: string
          slot_titles: string | null
          source_row: Json
          staff_id: string
          updated_at: string
        }
        Insert: {
          assignment_id?: string | null
          attending_consultant_ids?: string[]
          clwrota_external_id?: string | null
          created_at?: string
          detected_at?: string
          detected_by?: string
          duty_type?: Database["public"]["Enums"]["duty_type"] | null
          id?: string
          matched_field?: string | null
          matched_value?: string | null
          pa_credit?: number | null
          person_label?: string | null
          place_name?: string | null
          role_label?: string | null
          session: Database["public"]["Enums"]["session_half"]
          session_date: string
          slot_titles?: string | null
          source_row?: Json
          staff_id: string
          updated_at?: string
        }
        Update: {
          assignment_id?: string | null
          attending_consultant_ids?: string[]
          clwrota_external_id?: string | null
          created_at?: string
          detected_at?: string
          detected_by?: string
          duty_type?: Database["public"]["Enums"]["duty_type"] | null
          id?: string
          matched_field?: string | null
          matched_value?: string | null
          pa_credit?: number | null
          person_label?: string | null
          place_name?: string | null
          role_label?: string | null
          session?: Database["public"]["Enums"]["session_half"]
          session_date?: string
          slot_titles?: string | null
          source_row?: Json
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "icu_detection_matches_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "rota_assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "icu_detection_matches_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "icu_detection_matches_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "icu_detection_matches_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
        ]
      }
      inbox_dismissals: {
        Row: {
          dismissed_at: string
          dismissed_by: string
          item_id: string
          kind: string
        }
        Insert: {
          dismissed_at?: string
          dismissed_by: string
          item_id: string
          kind: string
        }
        Update: {
          dismissed_at?: string
          dismissed_by?: string
          item_id?: string
          kind?: string
        }
        Relationships: []
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
          {
            foreignKeyName: "job_plans_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_plans_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
        ]
      }
      leave_allowances: {
        Row: {
          annual_days: number
          carers_days: number
          carry_over_days: number
          compassionate_days: number
          created_at: string
          id: string
          leave_year_start: string
          ltft_fraction: number
          parental_days: number
          professional_days: number
          sla_target_days: number
          staff_id: string
          study_budget_gbp: number
          study_days: number
          updated_at: string
        }
        Insert: {
          annual_days?: number
          carers_days?: number
          carry_over_days?: number
          compassionate_days?: number
          created_at?: string
          id?: string
          leave_year_start: string
          ltft_fraction?: number
          parental_days?: number
          professional_days?: number
          sla_target_days?: number
          staff_id: string
          study_budget_gbp?: number
          study_days?: number
          updated_at?: string
        }
        Update: {
          annual_days?: number
          carers_days?: number
          carry_over_days?: number
          compassionate_days?: number
          created_at?: string
          id?: string
          leave_year_start?: string
          ltft_fraction?: number
          parental_days?: number
          professional_days?: number
          sla_target_days?: number
          staff_id?: string
          study_budget_gbp?: number
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
          {
            foreignKeyName: "leave_allowances_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_allowances_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
        ]
      }
      leave_change_log: {
        Row: {
          action: string
          changed_at: string
          changed_by: string | null
          id: string
          leave_request_id: string
          new_end_date: string | null
          new_start_date: string | null
          new_status: string | null
          new_type: string | null
          prev_end_date: string | null
          prev_start_date: string | null
          prev_status: string | null
          prev_type: string | null
          staff_id: string
        }
        Insert: {
          action: string
          changed_at?: string
          changed_by?: string | null
          id?: string
          leave_request_id: string
          new_end_date?: string | null
          new_start_date?: string | null
          new_status?: string | null
          new_type?: string | null
          prev_end_date?: string | null
          prev_start_date?: string | null
          prev_status?: string | null
          prev_type?: string | null
          staff_id: string
        }
        Update: {
          action?: string
          changed_at?: string
          changed_by?: string | null
          id?: string
          leave_request_id?: string
          new_end_date?: string | null
          new_start_date?: string | null
          new_status?: string | null
          new_type?: string | null
          prev_end_date?: string | null
          prev_start_date?: string | null
          prev_status?: string | null
          prev_type?: string | null
          staff_id?: string
        }
        Relationships: []
      }
      leave_ledger_entries: {
        Row: {
          created_at: string
          created_by: string | null
          entry_date: string
          hours: number
          id: string
          kind: string
          reason: string | null
          reason_enc: string | null
          related_leave_request_id: string | null
          staff_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          entry_date: string
          hours: number
          id?: string
          kind: string
          reason?: string | null
          reason_enc?: string | null
          related_leave_request_id?: string | null
          staff_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          entry_date?: string
          hours?: number
          id?: string
          kind?: string
          reason?: string | null
          reason_enc?: string | null
          related_leave_request_id?: string | null
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "leave_ledger_entries_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_ledger_entries_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_ledger_entries_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_ledger_entries_related_leave_request_id_fkey"
            columns: ["related_leave_request_id"]
            isOneToOne: false
            referencedRelation: "leave_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_ledger_entries_related_leave_request_id_fkey"
            columns: ["related_leave_request_id"]
            isOneToOne: false
            referencedRelation: "leave_requests_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_ledger_entries_related_leave_request_id_fkey"
            columns: ["related_leave_request_id"]
            isOneToOne: false
            referencedRelation: "leave_requests_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_ledger_entries_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_ledger_entries_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_ledger_entries_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
        ]
      }
      leave_requests: {
        Row: {
          clwrota_external_id: string | null
          conflict_notes: string | null
          conflict_notes_enc: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision_notes: string | null
          decision_notes_enc: string | null
          end_date: string
          half_day_end: Database["public"]["Enums"]["session_half"] | null
          half_day_start: Database["public"]["Enums"]["session_half"] | null
          id: string
          reason: string | null
          reason_enc: string | null
          reserve_listed_at: string | null
          staff_id: string
          start_date: string
          status: Database["public"]["Enums"]["leave_status"]
          study_cost_gbp: number | null
          type: Database["public"]["Enums"]["leave_type"]
          updated_at: string
        }
        Insert: {
          clwrota_external_id?: string | null
          conflict_notes?: string | null
          conflict_notes_enc?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_notes?: string | null
          decision_notes_enc?: string | null
          end_date: string
          half_day_end?: Database["public"]["Enums"]["session_half"] | null
          half_day_start?: Database["public"]["Enums"]["session_half"] | null
          id?: string
          reason?: string | null
          reason_enc?: string | null
          reserve_listed_at?: string | null
          staff_id: string
          start_date: string
          status?: Database["public"]["Enums"]["leave_status"]
          study_cost_gbp?: number | null
          type: Database["public"]["Enums"]["leave_type"]
          updated_at?: string
        }
        Update: {
          clwrota_external_id?: string | null
          conflict_notes?: string | null
          conflict_notes_enc?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_notes?: string | null
          decision_notes_enc?: string | null
          end_date?: string
          half_day_end?: Database["public"]["Enums"]["session_half"] | null
          half_day_start?: Database["public"]["Enums"]["session_half"] | null
          id?: string
          reason?: string | null
          reason_enc?: string | null
          reserve_listed_at?: string | null
          staff_id?: string
          start_date?: string
          status?: Database["public"]["Enums"]["leave_status"]
          study_cost_gbp?: number | null
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
            foreignKeyName: "leave_requests_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
        ]
      }
      passkey_challenges: {
        Row: {
          challenge: string
          created_at: string
          email_hash: string | null
          expires_at: string
          id: string
          purpose: string
          user_id: string | null
        }
        Insert: {
          challenge: string
          created_at?: string
          email_hash?: string | null
          expires_at?: string
          id?: string
          purpose: string
          user_id?: string | null
        }
        Update: {
          challenge?: string
          created_at?: string
          email_hash?: string | null
          expires_at?: string
          id?: string
          purpose?: string
          user_id?: string | null
        }
        Relationships: []
      }
      passkey_credentials: {
        Row: {
          counter: number
          created_at: string
          credential_id: string
          device_name: string | null
          id: string
          last_used_at: string | null
          public_key: string
          transports: string[] | null
          user_id: string
        }
        Insert: {
          counter?: number
          created_at?: string
          credential_id: string
          device_name?: string | null
          id?: string
          last_used_at?: string | null
          public_key: string
          transports?: string[] | null
          user_id: string
        }
        Update: {
          counter?: number
          created_at?: string
          credential_id?: string
          device_name?: string | null
          id?: string
          last_used_at?: string | null
          public_key?: string
          transports?: string[] | null
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          active: boolean
          calendar_feed_token: string | null
          clwrota_external_id: string | null
          created_at: string
          email: string
          email_enc: string | null
          email_hash: string | null
          full_name: string
          gmc_number: string | null
          gmc_number_enc: string | null
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
          calendar_feed_token?: string | null
          clwrota_external_id?: string | null
          created_at?: string
          email: string
          email_enc?: string | null
          email_hash?: string | null
          full_name?: string
          gmc_number?: string | null
          gmc_number_enc?: string | null
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
          calendar_feed_token?: string | null
          clwrota_external_id?: string | null
          created_at?: string
          email?: string
          email_enc?: string | null
          email_hash?: string | null
          full_name?: string
          gmc_number?: string | null
          gmc_number_enc?: string | null
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
      pulse_survey_cycles: {
        Row: {
          active: boolean
          closes_at: string
          created_at: string
          created_by: string | null
          id: string
          opens_at: string
          question_1: string
          question_2: string
          question_3: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          closes_at: string
          created_at?: string
          created_by?: string | null
          id?: string
          opens_at: string
          question_1: string
          question_2: string
          question_3: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          closes_at?: string
          created_at?: string
          created_by?: string | null
          id?: string
          opens_at?: string
          question_1?: string
          question_2?: string
          question_3?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pulse_survey_cycles_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pulse_survey_cycles_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pulse_survey_cycles_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
        ]
      }
      pulse_survey_responses: {
        Row: {
          comment: string | null
          comment_enc: string | null
          created_at: string
          cycle_id: string
          id: string
          score_1: number
          score_2: number
          score_3: number
          staff_id: string
          updated_at: string
        }
        Insert: {
          comment?: string | null
          comment_enc?: string | null
          created_at?: string
          cycle_id: string
          id?: string
          score_1: number
          score_2: number
          score_3: number
          staff_id: string
          updated_at?: string
        }
        Update: {
          comment?: string | null
          comment_enc?: string | null
          created_at?: string
          cycle_id?: string
          id?: string
          score_1?: number
          score_2?: number
          score_3?: number
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pulse_survey_responses_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "pulse_survey_cycles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pulse_survey_responses_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pulse_survey_responses_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pulse_survey_responses_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
        ]
      }
      push_notification_log: {
        Row: {
          change_log_id: string | null
          error: string | null
          id: string
          leave_change_log_id: string | null
          sent_at: string
          staff_id: string
          status: string
          subscription_id: string | null
        }
        Insert: {
          change_log_id?: string | null
          error?: string | null
          id?: string
          leave_change_log_id?: string | null
          sent_at?: string
          staff_id: string
          status: string
          subscription_id?: string | null
        }
        Update: {
          change_log_id?: string | null
          error?: string | null
          id?: string
          leave_change_log_id?: string | null
          sent_at?: string
          staff_id?: string
          status?: string
          subscription_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "push_notification_log_change_log_id_fkey"
            columns: ["change_log_id"]
            isOneToOne: false
            referencedRelation: "rota_change_log"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_notification_log_leave_change_log_id_fkey"
            columns: ["leave_change_log_id"]
            isOneToOne: false
            referencedRelation: "leave_change_log"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_notification_log_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "push_subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          id: string
          last_used_at: string
          p256dh: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          id?: string
          last_used_at?: string
          p256dh: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          id?: string
          last_used_at?: string
          p256dh?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      recognition_entries: {
        Row: {
          category: string
          created_at: string
          from_user_id: string
          id: string
          is_public: boolean
          message: string | null
          message_enc: string | null
          staff_id: string
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          from_user_id: string
          id?: string
          is_public?: boolean
          message?: string | null
          message_enc?: string | null
          staff_id: string
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          from_user_id?: string
          id?: string
          is_public?: boolean
          message?: string | null
          message_enc?: string | null
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recognition_entries_from_user_id_fkey"
            columns: ["from_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recognition_entries_from_user_id_fkey"
            columns: ["from_user_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recognition_entries_from_user_id_fkey"
            columns: ["from_user_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recognition_entries_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recognition_entries_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recognition_entries_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
        ]
      }
      return_to_work_interviews: {
        Row: {
          conducted_at: string
          conducted_by: string | null
          created_at: string
          fitness_confirmed: boolean
          follow_up_date: string | null
          follow_up_required: boolean
          id: string
          leave_request_id: string
          notes: string | null
          notes_enc: string | null
          reasonable_adjustments: string | null
          reasonable_adjustments_enc: string | null
          staff_id: string
          updated_at: string
        }
        Insert: {
          conducted_at?: string
          conducted_by?: string | null
          created_at?: string
          fitness_confirmed?: boolean
          follow_up_date?: string | null
          follow_up_required?: boolean
          id?: string
          leave_request_id: string
          notes?: string | null
          notes_enc?: string | null
          reasonable_adjustments?: string | null
          reasonable_adjustments_enc?: string | null
          staff_id: string
          updated_at?: string
        }
        Update: {
          conducted_at?: string
          conducted_by?: string | null
          created_at?: string
          fitness_confirmed?: boolean
          follow_up_date?: string | null
          follow_up_required?: boolean
          id?: string
          leave_request_id?: string
          notes?: string | null
          notes_enc?: string | null
          reasonable_adjustments?: string | null
          reasonable_adjustments_enc?: string | null
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "return_to_work_interviews_leave_request_id_fkey"
            columns: ["leave_request_id"]
            isOneToOne: true
            referencedRelation: "leave_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "return_to_work_interviews_leave_request_id_fkey"
            columns: ["leave_request_id"]
            isOneToOne: true
            referencedRelation: "leave_requests_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "return_to_work_interviews_leave_request_id_fkey"
            columns: ["leave_request_id"]
            isOneToOne: true
            referencedRelation: "leave_requests_v"
            referencedColumns: ["id"]
          },
        ]
      }
      rota_assignments: {
        Row: {
          attending_consultant_ids: string[]
          clwrota_external_id: string | null
          created_at: string
          duty_type: Database["public"]["Enums"]["duty_type"]
          extra_type: string | null
          id: string
          is_non_sag: boolean
          locally_modified: boolean
          notes: string | null
          pa_credit: number | null
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
          attending_consultant_ids?: string[]
          clwrota_external_id?: string | null
          created_at?: string
          duty_type?: Database["public"]["Enums"]["duty_type"]
          extra_type?: string | null
          id?: string
          is_non_sag?: boolean
          locally_modified?: boolean
          notes?: string | null
          pa_credit?: number | null
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
          attending_consultant_ids?: string[]
          clwrota_external_id?: string | null
          created_at?: string
          duty_type?: Database["public"]["Enums"]["duty_type"]
          extra_type?: string | null
          id?: string
          is_non_sag?: boolean
          locally_modified?: boolean
          notes?: string | null
          pa_credit?: number | null
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
            foreignKeyName: "rota_assignments_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rota_assignments_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
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
            foreignKeyName: "rota_assignments_supervisor_id_fkey"
            columns: ["supervisor_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rota_assignments_supervisor_id_fkey"
            columns: ["supervisor_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
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
          new_theatre_session_id: string | null
          prev_staff_id: string | null
          prev_theatre_session_id: string | null
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
          new_theatre_session_id?: string | null
          prev_staff_id?: string | null
          prev_theatre_session_id?: string | null
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
          new_theatre_session_id?: string | null
          prev_staff_id?: string | null
          prev_theatre_session_id?: string | null
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
      rpc_access_alerts: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          alert_type: string
          call_count: number
          created_at: string
          details: Json
          id: number
          rpc_name: string
          subject_user: string | null
          threshold: number | null
          window_end: string
          window_start: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          alert_type: string
          call_count: number
          created_at?: string
          details?: Json
          id?: number
          rpc_name: string
          subject_user?: string | null
          threshold?: number | null
          window_end: string
          window_start: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          alert_type?: string
          call_count?: number
          created_at?: string
          details?: Json
          id?: number
          rpc_name?: string
          subject_user?: string | null
          threshold?: number | null
          window_end?: string
          window_start?: string
        }
        Relationships: []
      }
      rpc_access_audit: {
        Row: {
          args: Json | null
          called_at: string
          called_by: string | null
          db_role: string
          id: number
          row_count: number | null
          rpc_name: string
        }
        Insert: {
          args?: Json | null
          called_at?: string
          called_by?: string | null
          db_role?: string
          id?: number
          row_count?: number | null
          rpc_name: string
        }
        Update: {
          args?: Json | null
          called_at?: string
          called_by?: string | null
          db_role?: string
          id?: number
          row_count?: number | null
          rpc_name?: string
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
      specialty_competency_requirements: {
        Row: {
          applies_to_role: string
          competency_id: string
          created_at: string
          id: string
          notes: string | null
          requirement: string
          specialty_id: string
          updated_at: string
        }
        Insert: {
          applies_to_role?: string
          competency_id: string
          created_at?: string
          id?: string
          notes?: string | null
          requirement?: string
          specialty_id: string
          updated_at?: string
        }
        Update: {
          applies_to_role?: string
          competency_id?: string
          created_at?: string
          id?: string
          notes?: string | null
          requirement?: string
          specialty_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "specialty_competency_requirements_competency_id_fkey"
            columns: ["competency_id"]
            isOneToOne: false
            referencedRelation: "competencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "specialty_competency_requirements_specialty_id_fkey"
            columns: ["specialty_id"]
            isOneToOne: false
            referencedRelation: "specialties"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_competencies: {
        Row: {
          competency_id: string
          created_at: string
          expires_at: string | null
          granted_at: string
          granted_by: string | null
          id: string
          level: string | null
          notes: string | null
          revoked_at: string | null
          staff_id: string
          updated_at: string
        }
        Insert: {
          competency_id: string
          created_at?: string
          expires_at?: string | null
          granted_at?: string
          granted_by?: string | null
          id?: string
          level?: string | null
          notes?: string | null
          revoked_at?: string | null
          staff_id: string
          updated_at?: string
        }
        Update: {
          competency_id?: string
          created_at?: string
          expires_at?: string | null
          granted_at?: string
          granted_by?: string | null
          id?: string
          level?: string | null
          notes?: string | null
          revoked_at?: string | null
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_competencies_competency_id_fkey"
            columns: ["competency_id"]
            isOneToOne: false
            referencedRelation: "competencies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_competencies_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_competencies_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_competencies_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_competencies_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_competencies_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_competencies_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_practice_preferences: {
        Row: {
          covers_cleft_palate: boolean
          covers_obstetrics: boolean
          covers_paediatrics: boolean
          created_at: string
          notes: string | null
          staff_id: string
          updated_at: string
        }
        Insert: {
          covers_cleft_palate?: boolean
          covers_obstetrics?: boolean
          covers_paediatrics?: boolean
          created_at?: string
          notes?: string | null
          staff_id: string
          updated_at?: string
        }
        Update: {
          covers_cleft_palate?: boolean
          covers_obstetrics?: boolean
          covers_paediatrics?: boolean
          created_at?: string
          notes?: string | null
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_practice_preferences_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_practice_preferences_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: true
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_practice_preferences_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: true
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_specialty_preferences: {
        Row: {
          created_at: string
          id: string
          preference: Database["public"]["Enums"]["specialty_preference"]
          specialty_id: string
          staff_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          preference?: Database["public"]["Enums"]["specialty_preference"]
          specialty_id: string
          staff_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          preference?: Database["public"]["Enums"]["specialty_preference"]
          specialty_id?: string
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_specialty_preferences_specialty_id_fkey"
            columns: ["specialty_id"]
            isOneToOne: false
            referencedRelation: "specialties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_specialty_preferences_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_specialty_preferences_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_specialty_preferences_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
        ]
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
      tutorial_audit_alerts: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          audit_count: number
          created_at: string
          details: Json
          id: string
          run_id: string | null
          source_count: number
          window_end: string
          window_start: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          audit_count?: number
          created_at?: string
          details?: Json
          id?: string
          run_id?: string | null
          source_count?: number
          window_end: string
          window_start: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          audit_count?: number
          created_at?: string
          details?: Json
          id?: string
          run_id?: string | null
          source_count?: number
          window_end?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "tutorial_audit_alerts_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "tutorial_audit_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      tutorial_audit_job_state: {
        Row: {
          consecutive_failures: number
          created_at: string
          cursor_start: string | null
          enabled: boolean
          horizon_end: string | null
          id: number
          last_error: string | null
          last_run_at: string | null
          lease_until: string | null
          next_pass_at: string
          pass_started_at: string | null
          paused: boolean
          paused_reason: string | null
          updated_at: string
        }
        Insert: {
          consecutive_failures?: number
          created_at?: string
          cursor_start?: string | null
          enabled?: boolean
          horizon_end?: string | null
          id?: number
          last_error?: string | null
          last_run_at?: string | null
          lease_until?: string | null
          next_pass_at?: string
          pass_started_at?: string | null
          paused?: boolean
          paused_reason?: string | null
          updated_at?: string
        }
        Update: {
          consecutive_failures?: number
          created_at?: string
          cursor_start?: string | null
          enabled?: boolean
          horizon_end?: string | null
          id?: number
          last_error?: string | null
          last_run_at?: string | null
          lease_until?: string | null
          next_pass_at?: string
          pass_started_at?: string | null
          paused?: boolean
          paused_reason?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      tutorial_audit_runs: {
        Row: {
          audit_count: number
          created_at: string
          details: Json
          diverged: boolean
          error: string | null
          id: string
          notes_updated: number
          ok: boolean
          promoted_to_teaching: number
          source_count: number
          window_end: string
          window_start: string
        }
        Insert: {
          audit_count?: number
          created_at?: string
          details?: Json
          diverged?: boolean
          error?: string | null
          id?: string
          notes_updated?: number
          ok?: boolean
          promoted_to_teaching?: number
          source_count?: number
          window_end: string
          window_start: string
        }
        Update: {
          audit_count?: number
          created_at?: string
          details?: Json
          diverged?: boolean
          error?: string | null
          id?: string
          notes_updated?: number
          ok?: boolean
          promoted_to_teaching?: number
          source_count?: number
          window_end?: string
          window_start?: string
        }
        Relationships: []
      }
      tutorial_detection_matches: {
        Row: {
          assignment_id: string | null
          clwrota_external_id: string | null
          created_at: string
          detected_at: string
          detected_by: string
          id: string
          matched_field: string | null
          matched_value: string | null
          person_label: string | null
          place_name: string | null
          role_label: string | null
          session: Database["public"]["Enums"]["session_half"]
          session_date: string
          slot_titles: string | null
          source_row: Json
          staff_id: string
          updated_at: string
        }
        Insert: {
          assignment_id?: string | null
          clwrota_external_id?: string | null
          created_at?: string
          detected_at?: string
          detected_by?: string
          id?: string
          matched_field?: string | null
          matched_value?: string | null
          person_label?: string | null
          place_name?: string | null
          role_label?: string | null
          session: Database["public"]["Enums"]["session_half"]
          session_date: string
          slot_titles?: string | null
          source_row?: Json
          staff_id: string
          updated_at?: string
        }
        Update: {
          assignment_id?: string | null
          clwrota_external_id?: string | null
          created_at?: string
          detected_at?: string
          detected_by?: string
          id?: string
          matched_field?: string | null
          matched_value?: string | null
          person_label?: string | null
          place_name?: string | null
          role_label?: string | null
          session?: Database["public"]["Enums"]["session_half"]
          session_date?: string
          slot_titles?: string | null
          source_row?: Json
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tutorial_detection_matches_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "rota_assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tutorial_detection_matches_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tutorial_detection_matches_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tutorial_detection_matches_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
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
      access_requests_admin_v: {
        Row: {
          created_at: string | null
          decided_at: string | null
          decided_by: string | null
          decision_notes: string | null
          email: string | null
          email_hash: string | null
          full_name: string | null
          id: string | null
          message: string | null
          status: Database["public"]["Enums"]["access_request_status"] | null
        }
        Insert: {
          created_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          decision_notes?: string | null
          email?: never
          email_hash?: string | null
          full_name?: string | null
          id?: string | null
          message?: string | null
          status?: Database["public"]["Enums"]["access_request_status"] | null
        }
        Update: {
          created_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          decision_notes?: string | null
          email?: never
          email_hash?: string | null
          full_name?: string | null
          id?: string | null
          message?: string | null
          status?: Database["public"]["Enums"]["access_request_status"] | null
        }
        Relationships: []
      }
      access_requests_v: {
        Row: {
          created_at: string | null
          decided_at: string | null
          decided_by: string | null
          decision_notes: string | null
          email: string | null
          email_hash: string | null
          full_name: string | null
          id: string | null
          message: string | null
          status: Database["public"]["Enums"]["access_request_status"] | null
        }
        Insert: {
          created_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          decision_notes?: string | null
          email?: never
          email_hash?: string | null
          full_name?: string | null
          id?: string | null
          message?: string | null
          status?: Database["public"]["Enums"]["access_request_status"] | null
        }
        Update: {
          created_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          decision_notes?: string | null
          email?: never
          email_hash?: string | null
          full_name?: string | null
          id?: string | null
          message?: string | null
          status?: Database["public"]["Enums"]["access_request_status"] | null
        }
        Relationships: []
      }
      ai_messages_admin_v: {
        Row: {
          conversation_id: string | null
          created_at: string | null
          id: string | null
          parts: Json | null
          role: Database["public"]["Enums"]["chat_role"] | null
          user_id: string | null
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string | null
          id?: string | null
          parts?: never
          role?: Database["public"]["Enums"]["chat_role"] | null
          user_id?: string | null
        }
        Update: {
          conversation_id?: string | null
          created_at?: string | null
          id?: string | null
          parts?: never
          role?: Database["public"]["Enums"]["chat_role"] | null
          user_id?: string | null
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
      ai_messages_v: {
        Row: {
          conversation_id: string | null
          created_at: string | null
          id: string | null
          parts: Json | null
          role: Database["public"]["Enums"]["chat_role"] | null
          user_id: string | null
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string | null
          id?: string | null
          parts?: never
          role?: Database["public"]["Enums"]["chat_role"] | null
          user_id?: string | null
        }
        Update: {
          conversation_id?: string | null
          created_at?: string | null
          id?: string | null
          parts?: never
          role?: Database["public"]["Enums"]["chat_role"] | null
          user_id?: string | null
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
      leave_requests_admin_v: {
        Row: {
          clwrota_external_id: string | null
          conflict_notes: string | null
          created_at: string | null
          decided_at: string | null
          decided_by: string | null
          decision_notes: string | null
          end_date: string | null
          half_day_end: Database["public"]["Enums"]["session_half"] | null
          half_day_start: Database["public"]["Enums"]["session_half"] | null
          id: string | null
          reason: string | null
          reserve_listed_at: string | null
          staff_id: string | null
          start_date: string | null
          status: Database["public"]["Enums"]["leave_status"] | null
          type: Database["public"]["Enums"]["leave_type"] | null
          updated_at: string | null
        }
        Insert: {
          clwrota_external_id?: string | null
          conflict_notes?: never
          created_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          decision_notes?: never
          end_date?: string | null
          half_day_end?: Database["public"]["Enums"]["session_half"] | null
          half_day_start?: Database["public"]["Enums"]["session_half"] | null
          id?: string | null
          reason?: never
          reserve_listed_at?: string | null
          staff_id?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["leave_status"] | null
          type?: Database["public"]["Enums"]["leave_type"] | null
          updated_at?: string | null
        }
        Update: {
          clwrota_external_id?: string | null
          conflict_notes?: never
          created_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          decision_notes?: never
          end_date?: string | null
          half_day_end?: Database["public"]["Enums"]["session_half"] | null
          half_day_start?: Database["public"]["Enums"]["session_half"] | null
          id?: string | null
          reason?: never
          reserve_listed_at?: string | null
          staff_id?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["leave_status"] | null
          type?: Database["public"]["Enums"]["leave_type"] | null
          updated_at?: string | null
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
            foreignKeyName: "leave_requests_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
        ]
      }
      leave_requests_v: {
        Row: {
          clwrota_external_id: string | null
          conflict_notes: string | null
          created_at: string | null
          decided_at: string | null
          decided_by: string | null
          decision_notes: string | null
          end_date: string | null
          half_day_end: Database["public"]["Enums"]["session_half"] | null
          half_day_start: Database["public"]["Enums"]["session_half"] | null
          id: string | null
          reason: string | null
          reserve_listed_at: string | null
          staff_id: string | null
          start_date: string | null
          status: Database["public"]["Enums"]["leave_status"] | null
          type: Database["public"]["Enums"]["leave_type"] | null
          updated_at: string | null
        }
        Insert: {
          clwrota_external_id?: string | null
          conflict_notes?: never
          created_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          decision_notes?: never
          end_date?: string | null
          half_day_end?: Database["public"]["Enums"]["session_half"] | null
          half_day_start?: Database["public"]["Enums"]["session_half"] | null
          id?: string | null
          reason?: never
          reserve_listed_at?: string | null
          staff_id?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["leave_status"] | null
          type?: Database["public"]["Enums"]["leave_type"] | null
          updated_at?: string | null
        }
        Update: {
          clwrota_external_id?: string | null
          conflict_notes?: never
          created_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          decision_notes?: never
          end_date?: string | null
          half_day_end?: Database["public"]["Enums"]["session_half"] | null
          half_day_start?: Database["public"]["Enums"]["session_half"] | null
          id?: string | null
          reason?: never
          reserve_listed_at?: string | null
          staff_id?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["leave_status"] | null
          type?: Database["public"]["Enums"]["leave_type"] | null
          updated_at?: string | null
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
            foreignKeyName: "leave_requests_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_admin_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "profiles_v"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles_admin_v: {
        Row: {
          active: boolean | null
          calendar_feed_token: string | null
          clwrota_external_id: string | null
          created_at: string | null
          email: string | null
          email_hash: string | null
          full_name: string | null
          gmc_number: string | null
          grade: Database["public"]["Enums"]["staff_grade"] | null
          id: string | null
          left_at: string | null
          ltft_days_off: number[] | null
          rotation_end_date: string | null
          start_date: string | null
          training_level: string | null
          updated_at: string | null
        }
        Insert: {
          active?: boolean | null
          calendar_feed_token?: string | null
          clwrota_external_id?: string | null
          created_at?: string | null
          email?: never
          email_hash?: string | null
          full_name?: string | null
          gmc_number?: never
          grade?: Database["public"]["Enums"]["staff_grade"] | null
          id?: string | null
          left_at?: string | null
          ltft_days_off?: number[] | null
          rotation_end_date?: string | null
          start_date?: string | null
          training_level?: string | null
          updated_at?: string | null
        }
        Update: {
          active?: boolean | null
          calendar_feed_token?: string | null
          clwrota_external_id?: string | null
          created_at?: string | null
          email?: never
          email_hash?: string | null
          full_name?: string | null
          gmc_number?: never
          grade?: Database["public"]["Enums"]["staff_grade"] | null
          id?: string | null
          left_at?: string | null
          ltft_days_off?: number[] | null
          rotation_end_date?: string | null
          start_date?: string | null
          training_level?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      profiles_v: {
        Row: {
          active: boolean | null
          calendar_feed_token: string | null
          clwrota_external_id: string | null
          created_at: string | null
          email: string | null
          email_hash: string | null
          full_name: string | null
          gmc_number: string | null
          grade: Database["public"]["Enums"]["staff_grade"] | null
          id: string | null
          left_at: string | null
          ltft_days_off: number[] | null
          rotation_end_date: string | null
          start_date: string | null
          training_level: string | null
          updated_at: string | null
        }
        Insert: {
          active?: boolean | null
          calendar_feed_token?: string | null
          clwrota_external_id?: string | null
          created_at?: string | null
          email?: never
          email_hash?: string | null
          full_name?: string | null
          gmc_number?: never
          grade?: Database["public"]["Enums"]["staff_grade"] | null
          id?: string | null
          left_at?: string | null
          ltft_days_off?: number[] | null
          rotation_end_date?: string | null
          start_date?: string | null
          training_level?: string | null
          updated_at?: string | null
        }
        Update: {
          active?: boolean | null
          calendar_feed_token?: string | null
          clwrota_external_id?: string | null
          created_at?: string | null
          email?: never
          email_hash?: string | null
          full_name?: string | null
          gmc_number?: never
          grade?: Database["public"]["Enums"]["staff_grade"] | null
          id?: string | null
          left_at?: string | null
          ltft_days_off?: number[] | null
          rotation_end_date?: string | null
          start_date?: string | null
          training_level?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      _enc_key: { Args: never; Returns: string }
      _hmac_key: { Args: never; Returns: string }
      admin_decrypt_jsonb: { Args: { p_cipher: string }; Returns: Json }
      admin_decrypt_text: { Args: { p_cipher: string }; Returns: string }
      admin_run_readonly_sql: { Args: { p_query: string }; Returns: Json }
      consume_passkey_challenge: {
        Args: { p_purpose: string; p_user_id: string }
        Returns: {
          challenge: string
        }[]
      }
      current_user_is_coordinator_or_admin: { Args: never; Returns: boolean }
      decrypt_ai_message_parts: {
        Args: { p_cipher: string; p_conversation_id: string }
        Returns: Json
      }
      decrypt_coord_only: { Args: { p_cipher: string }; Returns: string }
      decrypt_jsonb: { Args: { p_cipher: string }; Returns: Json }
      decrypt_owner_or_coord: {
        Args: { p_cipher: string; p_owner: string }
        Returns: string
      }
      decrypt_text: { Args: { p_cipher: string }; Returns: string }
      detect_rpc_access_anomalies: {
        Args: { p_threshold?: number; p_window_minutes?: number }
        Returns: number
      }
      encrypt_jsonb: { Args: { p_plain: Json }; Returns: string }
      encrypt_text: { Args: { p_plain: string }; Returns: string }
      find_access_request_by_email: {
        Args: { p_email: string }
        Returns: {
          created_at: string
          full_name: string
          id: string
          status: string
        }[]
      }
      find_profile_id_by_email: { Args: { p_email: string }; Returns: string }
      get_access_requests_decrypted: {
        Args: never
        Returns: {
          created_at: string
          decided_at: string
          decided_by: string
          decision_notes: string
          email: string
          full_name: string
          id: string
          message: string
          status: Database["public"]["Enums"]["access_request_status"]
        }[]
      }
      get_ai_messages_decrypted: {
        Args: { p_conversation_id: string }
        Returns: {
          conversation_id: string
          created_at: string
          id: string
          parts: Json
          role: Database["public"]["Enums"]["chat_role"]
          user_id: string
        }[]
      }
      get_competency_eligibility: {
        Args: { p_on_date?: string }
        Returns: {
          eligible_solo: boolean
          eligible_supervising: boolean
          full_name: string
          grade: Database["public"]["Enums"]["staff_grade"]
          specialty_id: string
          specialty_name: string
          staff_id: string
        }[]
      }
      get_leave_ledger_decrypted: {
        Args: never
        Returns: {
          created_at: string
          created_by: string
          entry_date: string
          hours: number
          id: string
          kind: string
          reason: string
          related_leave_request_id: string
          staff_id: string
          updated_at: string
        }[]
      }
      get_leave_requests_decrypted: {
        Args: never
        Returns: {
          clwrota_external_id: string
          conflict_notes: string
          created_at: string
          decided_at: string
          decided_by: string
          decision_notes: string
          end_date: string
          half_day_end: Database["public"]["Enums"]["session_half"]
          half_day_start: Database["public"]["Enums"]["session_half"]
          id: string
          reason: string
          reserve_listed_at: string
          staff_id: string
          start_date: string
          status: Database["public"]["Enums"]["leave_status"]
          type: Database["public"]["Enums"]["leave_type"]
          updated_at: string
        }[]
      }
      get_profile_decrypted: {
        Args: { p_id: string }
        Returns: {
          active: boolean
          calendar_feed_token: string
          clwrota_external_id: string
          created_at: string
          email: string
          full_name: string
          gmc_number: string
          grade: Database["public"]["Enums"]["staff_grade"]
          id: string
          left_at: string
          ltft_days_off: number[]
          rotation_end_date: string
          start_date: string
          training_level: string
          updated_at: string
        }[]
      }
      get_profiles_decrypted: {
        Args: never
        Returns: {
          active: boolean
          calendar_feed_token: string
          clwrota_external_id: string
          created_at: string
          email: string
          full_name: string
          gmc_number: string
          grade: Database["public"]["Enums"]["staff_grade"]
          id: string
          left_at: string
          ltft_days_off: number[]
          rotation_end_date: string
          start_date: string
          training_level: string
          updated_at: string
        }[]
      }
      get_pulse_aggregate: {
        Args: { p_cycle_id?: string }
        Returns: {
          avg_score_1: number
          avg_score_2: number
          avg_score_3: number
          closes_at: string
          cycle_id: string
          opens_at: string
          response_count: number
        }[]
      }
      get_pulse_responses_decrypted: {
        Args: { p_cycle_id?: string }
        Returns: {
          comment: string
          created_at: string
          cycle_id: string
          id: string
          score_1: number
          score_2: number
          score_3: number
          staff_id: string
        }[]
      }
      get_recognition_decrypted: {
        Args: { p_limit?: number; p_staff_id?: string }
        Returns: {
          category: string
          created_at: string
          from_user_id: string
          id: string
          is_public: boolean
          message: string
          staff_id: string
        }[]
      }
      get_rtw_interviews_decrypted: {
        Args: never
        Returns: {
          conducted_at: string
          conducted_by: string
          created_at: string
          fitness_confirmed: boolean
          follow_up_date: string
          follow_up_required: boolean
          id: string
          leave_request_id: string
          notes: string
          reasonable_adjustments: string
          staff_id: string
          updated_at: string
        }[]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      hmac_text: { Args: { p_plain: string }; Returns: string }
      list_clwrota_cron_runs: {
        Args: { p_limit?: number }
        Returns: {
          active: boolean
          command: string
          end_time: string
          jobname: string
          return_message: string
          runid: number
          schedule: string
          start_time: string
          status: string
        }[]
      }
      log_rpc_access: {
        Args: { p_args?: Json; p_row_count: number; p_rpc_name: string }
        Returns: undefined
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
      trigger_clwrota_sync_all_rate_limited: { Args: never; Returns: Json }
      trigger_clwrota_sync_rate_limited: {
        Args: { p_step: string }
        Returns: number
      }
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
        | "medical_examiner"
      leave_status: "pending" | "approved" | "rejected" | "cancelled"
      leave_type:
        | "annual"
        | "study"
        | "compassionate"
        | "sick"
        | "parental"
        | "other"
        | "professional"
        | "carers"
        | "jury"
        | "industrial"
        | "toil"
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
      specialty_preference: "preferred" | "willing" | "prefer_not_to" | "none"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
        "medical_examiner",
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
        "carers",
        "jury",
        "industrial",
        "toil",
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
      specialty_preference: ["preferred", "willing", "prefer_not_to", "none"],
      staff_grade: ["consultant", "sas", "trainee"],
      theatre_kind: ["main", "day_surgery", "private"],
    },
  },
} as const
