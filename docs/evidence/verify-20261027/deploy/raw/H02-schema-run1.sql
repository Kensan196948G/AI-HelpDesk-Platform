--
-- PostgreSQL database dump
--

\restrict h1CLXRJ2Rdi3eDyHgpaz1XagEABaWf7jBbPRO73vrwDZJMZjEQqKAZYLVg34oqX

-- Dumped from database version 16.14
-- Dumped by pg_dump version 17.10 (Ubuntu 17.10-1.pgdg24.04+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    actor_id uuid,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    prev_hash text NOT NULL,
    hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;


--
-- Name: case_handover_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_handover_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    handover_id uuid NOT NULL,
    channel text DEFAULT 'email'::text NOT NULL,
    recipient_email text NOT NULL,
    recipient_name text,
    subject text NOT NULL,
    body text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT case_handover_notifications_channel_check CHECK ((channel = 'email'::text)),
    CONSTRAINT case_handover_notifications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'skipped'::text])))
);


--
-- Name: case_handovers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_handovers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    case_id text NOT NULL,
    owner_email text NOT NULL,
    assignee_hint text,
    status text DEFAULT 'pending'::text NOT NULL,
    snapshot jsonb NOT NULL,
    claimed_by text,
    claimed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    recipient_no text,
    recipient_name text,
    approved_by text,
    approved_at timestamp with time zone,
    self_approved boolean DEFAULT false NOT NULL,
    CONSTRAINT case_handovers_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'claimed'::text, 'resolved'::text, 'completed'::text, 'cancelled'::text])))
);


--
-- Name: case_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_messages (
    id bigint NOT NULL,
    case_id uuid NOT NULL,
    author_id uuid,
    role text NOT NULL,
    kind text NOT NULL,
    content text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT case_messages_kind_check CHECK ((kind = ANY (ARRAY['consultation'::text, 'ai_assessment'::text, 'decision'::text, 'handoff'::text, 'resolution'::text, 'knowledge'::text, 'note'::text]))),
    CONSTRAINT case_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'system'::text])))
);


--
-- Name: case_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_messages_id_seq OWNED BY public.case_messages.id;


--
-- Name: case_no_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_no_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    case_no text NOT NULL,
    requester_id uuid NOT NULL,
    category text NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    urgency text DEFAULT 'normal'::text NOT NULL,
    signal text DEFAULT 'blue'::text NOT NULL,
    current_step integer DEFAULT 2 NOT NULL,
    status text DEFAULT 'awaiting_decision'::text NOT NULL,
    ai_resolved boolean DEFAULT false NOT NULL,
    ai_summary text,
    shared_pc_info boolean DEFAULT false NOT NULL,
    resolved_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cases_category_check CHECK ((category = ANY (ARRAY['pc_network'::text, 'account'::text, 'file_share'::text, 'procedure'::text, 'security'::text, 'other'::text]))),
    CONSTRAINT cases_current_step_check CHECK (((current_step >= 1) AND (current_step <= 7))),
    CONSTRAINT cases_signal_check CHECK ((signal = ANY (ARRAY['blue'::text, 'amber'::text, 'red'::text]))),
    CONSTRAINT cases_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'awaiting_decision'::text, 'ai_resolved'::text, 'handoff_pending'::text, 'in_progress'::text, 'knowledge_pending'::text, 'completed'::text, 'cancelled'::text]))),
    CONSTRAINT cases_urgency_check CHECK ((urgency = ANY (ARRAY['normal'::text, 'urgent'::text])))
);


--
-- Name: device_commands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_commands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_email text NOT NULL,
    device_id text,
    op_id text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    result jsonb,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    completed_at timestamp with time zone,
    skill_id text,
    skill_version text,
    session_id uuid,
    step_id uuid,
    skill_content_hash text,
    CONSTRAINT device_commands_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'delivered'::text, 'done'::text, 'failed'::text, 'expired'::text])))
);


--
-- Name: device_inventories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_inventories (
    user_email text NOT NULL,
    source text NOT NULL,
    device_id text NOT NULL,
    hostname text,
    os text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    collected_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT device_inventories_source_check CHECK ((source = ANY (ARRAY['browser'::text, 'agent'::text])))
);


--
-- Name: device_mesh_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_mesh_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_email text NOT NULL,
    device_id text NOT NULL,
    hostname text NOT NULL,
    rsp_device_id uuid NOT NULL,
    mesh_node_id text,
    mapping_status text DEFAULT 'verified'::text NOT NULL,
    verified_by text NOT NULL,
    verified_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT device_mesh_links_status_check CHECK ((mapping_status = ANY (ARRAY['verified'::text, 'ambiguous'::text])))
);


--
-- Name: TABLE device_mesh_links; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.device_mesh_links IS 'AI HelpDesk 端末と RSP 端末の対応（推測で結ばない）';


--
-- Name: device_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_tokens (
    token_hash text NOT NULL,
    user_email text NOT NULL,
    label text DEFAULT 'endpoint-agent'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    device_id text,
    privilege text DEFAULT 'standard'::text NOT NULL,
    CONSTRAINT device_tokens_privilege_check CHECK ((privilege = ANY (ARRAY['standard'::text, 'admin'::text])))
);


--
-- Name: final_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.final_reports (
    id uuid NOT NULL,
    user_email text NOT NULL,
    case_id text NOT NULL,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    html text NOT NULL,
    html_filename text NOT NULL,
    sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT final_reports_kind_check CHECK ((kind = ANY (ARRAY['ai_resolved'::text, 'helpdesk_resolved'::text])))
);


--
-- Name: inc_no_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.inc_no_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: kb_no_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.kb_no_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knowledge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kb_no text NOT NULL,
    case_id uuid,
    resolution_id uuid,
    title text NOT NULL,
    symptom text NOT NULL,
    cause text NOT NULL,
    steps text NOT NULL,
    keywords text[] DEFAULT '{}'::text[] NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    author_id uuid NOT NULL,
    approver_id uuid,
    version integer DEFAULT 1 NOT NULL,
    approved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: knowledge_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    knowledge_id uuid NOT NULL,
    reviewer_id uuid NOT NULL,
    decision text NOT NULL,
    comment text DEFAULT ''::text NOT NULL,
    checklist jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_reviews_decision_check CHECK ((decision = ANY (ARRAY['approved'::text, 'rejected'::text])))
);


--
-- Name: mesh_install_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mesh_install_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    case_id text NOT NULL,
    resolve_session_id uuid,
    user_email text NOT NULL,
    device_id text NOT NULL,
    rsp_device_id uuid NOT NULL,
    hostname text NOT NULL,
    status text NOT NULL,
    triggered_deploy boolean DEFAULT false NOT NULL,
    agent_installed boolean DEFAULT false NOT NULL,
    agent_online boolean DEFAULT false NOT NULL,
    last_error text,
    requested_by text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mesh_install_requests_status_check CHECK ((status = ANY (ARRAY['requested'::text, 'triggered'::text, 'installed'::text, 'skipped'::text, 'failed'::text])))
);


--
-- Name: TABLE mesh_install_requests; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.mesh_install_requests IS 'MeshAgent 導入要求と結果（実行は RSP）';


--
-- Name: pc_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pc_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    case_id uuid NOT NULL,
    collected_at timestamp with time zone DEFAULT now() NOT NULL,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    concerns jsonb DEFAULT '[]'::jsonb NOT NULL,
    shared boolean DEFAULT false NOT NULL,
    source text DEFAULT 'demo'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pc_snapshots_source_check CHECK ((source = ANY (ARRAY['demo'::text, 'browser'::text, 'agent'::text])))
);


--
-- Name: prototype_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prototype_states (
    user_email text NOT NULL,
    name text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT prototype_states_name_check CHECK ((name = ANY (ARRAY['cowork'::text, 'helpdesk'::text])))
);


--
-- Name: resolution_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resolution_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_email text NOT NULL,
    case_id text NOT NULL,
    device_id text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    step_count integer DEFAULT 0 NOT NULL,
    max_steps integer DEFAULT 6 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_summary jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT resolution_sessions_max_steps_check CHECK ((max_steps > 0)),
    CONSTRAINT resolution_sessions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'waiting_execute'::text, 'executing'::text, 'waiting_continue'::text, 'resolved'::text, 'escalated'::text, 'stopped'::text, 'expired'::text]))),
    CONSTRAINT resolution_sessions_step_count_check CHECK ((step_count >= 0))
);


--
-- Name: resolution_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resolution_steps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    seq integer NOT NULL,
    skill_id text NOT NULL,
    skill_version text NOT NULL,
    skill_content_hash text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    rationale text DEFAULT ''::text NOT NULL,
    risk_level integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    nonce text NOT NULL,
    approval_hash text,
    admin_approval_hash text,
    approved_by text,
    approved_at timestamp with time zone,
    command_id uuid,
    result_summary jsonb,
    result_full jsonb,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    executed_at timestamp with time zone,
    approval_expires_at timestamp with time zone NOT NULL,
    result_ai jsonb,
    timeout_sec integer,
    deadline_at timestamp with time zone,
    admin_nonce text,
    admin_expires_at timestamp with time zone,
    admin_approved_by text,
    admin_approved_at timestamp with time zone,
    verify_result jsonb,
    verify_for_step_id uuid,
    CONSTRAINT resolution_steps_risk_level_check CHECK (((risk_level >= 1) AND (risk_level <= 5))),
    CONSTRAINT resolution_steps_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'approved'::text, 'executing'::text, 'done'::text, 'failed'::text, 'rejected'::text, 'cancelled'::text, 'skipped'::text])))
);


--
-- Name: COLUMN resolution_steps.result_ai; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.resolution_steps.result_ai IS 'outputPolicy.fieldsToAi 適用後の結果（AI 入力用）。生ログは含めない';


--
-- Name: COLUMN resolution_steps.deadline_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.resolution_steps.deadline_at IS '承認時に設定する実行期限。過ぎたらスイープが failed にする（014 で既存分を補完）';


--
-- Name: COLUMN resolution_steps.admin_approved_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.resolution_steps.admin_approved_by IS 'リスク 4 以上の Skill を承認した IT 管理者のメール（依頼者と同一不可）';


--
-- Name: COLUMN resolution_steps.verify_result; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.resolution_steps.verify_result IS 'サーバが評価した verify の結果（ok/evaluated/reason）。ok=null は評価不能（成功と見なさない）';


--
-- Name: COLUMN resolution_steps.verify_for_step_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.resolution_steps.verify_for_step_id IS '親ステップ ID（script 形態 verify の追撃実行）。NULL は通常ステップ。同一親に 1 回だけ';


--
-- Name: resolutions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resolutions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    case_id uuid NOT NULL,
    author_id uuid NOT NULL,
    cause text NOT NULL,
    steps text NOT NULL,
    duration_min integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT resolutions_duration_min_check CHECK ((duration_min >= 0))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: skills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.skills (
    id text NOT NULL,
    version text NOT NULL,
    title text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    symptoms jsonb DEFAULT '[]'::jsonb NOT NULL,
    os text[] DEFAULT '{}'::text[] NOT NULL,
    risk_level integer DEFAULT 1 NOT NULL,
    requires jsonb DEFAULT '{}'::jsonb NOT NULL,
    params_schema jsonb DEFAULT '{}'::jsonb NOT NULL,
    script_path text NOT NULL,
    args jsonb DEFAULT '[]'::jsonb NOT NULL,
    verify jsonb,
    rollback jsonb,
    timeout_sec integer DEFAULT 60 NOT NULL,
    result_schema jsonb,
    output_policy jsonb,
    status text DEFAULT 'draft'::text NOT NULL,
    content_hash text,
    approved_by text,
    approved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT skills_risk_level_check CHECK (((risk_level >= 1) AND (risk_level <= 5))),
    CONSTRAINT skills_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'review'::text, 'approved'::text, 'disabled'::text])))
);


--
-- Name: terminal_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.terminal_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    case_id text NOT NULL,
    handover_id uuid,
    device text DEFAULT 'unknown'::text NOT NULL,
    operator_email text NOT NULL,
    requester_email text,
    status text DEFAULT 'active'::text NOT NULL,
    close_reason text,
    close_note text,
    consent_screen_share boolean DEFAULT false NOT NULL,
    consent_remote_control boolean DEFAULT false NOT NULL,
    ai_model text,
    knowledge_id uuid,
    report_id uuid,
    report_sha256 text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    rsp_session_id text,
    CONSTRAINT terminal_sessions_close_reason_check CHECK (((close_reason IS NULL) OR (close_reason = ANY (ARRAY['resolved'::text, 'stopped'::text, 'escalated'::text, 'expired'::text])))),
    CONSTRAINT terminal_sessions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'closed'::text])))
);


--
-- Name: TABLE terminal_sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.terminal_sessions IS 'RSP 実行セッション。担当者の同意・TTL・終了理由・作成済み報告書/ナレッジを持つ';


--
-- Name: COLUMN terminal_sessions.rsp_session_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.terminal_sessions.rsp_session_id IS 'RSP の remote_session ID（terminal_session との相互参照用・NULL 可）';


--
-- Name: terminal_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.terminal_steps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    seq integer NOT NULL,
    operator_email text NOT NULL,
    intent text,
    ai_command text,
    ai_purpose text,
    ai_risk text,
    ai_verify text,
    ai_rollback text,
    ai_warnings jsonb DEFAULT '[]'::jsonb NOT NULL,
    ai_model text,
    executed_command text,
    output text,
    output_source text,
    exit_status text,
    note text,
    sha256 text,
    proposed_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_at timestamp with time zone,
    rsp_command_log_id text,
    CONSTRAINT terminal_steps_ai_risk_check CHECK (((ai_risk IS NULL) OR (ai_risk = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])))),
    CONSTRAINT terminal_steps_exit_status_check CHECK (((exit_status IS NULL) OR (exit_status = ANY (ARRAY['success'::text, 'failure'::text, 'unknown'::text])))),
    CONSTRAINT terminal_steps_output_source_check CHECK (((output_source IS NULL) OR (output_source = ANY (ARRAY['auto'::text, 'manual'::text, 'rsp_command'::text])))),
    CONSTRAINT terminal_steps_seq_check CHECK (((seq >= 1) AND (seq <= 20)))
);


--
-- Name: TABLE terminal_steps; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.terminal_steps IS 'AI の提案と、担当者が実行したコマンド・出力（PII マスク済み）を 1 ステップ 1 行で保持する';


--
-- Name: COLUMN terminal_steps.sha256; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.terminal_steps.sha256 IS '実行記録のハッシュ。対象は sessionId/stepId/seq/command/output/outputSource/exitStatus（マスク後）';


--
-- Name: COLUMN terminal_steps.rsp_command_log_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.terminal_steps.rsp_command_log_id IS 'RSP W23 コマンドキューの command log_id（outputSource=''rsp_command'' のときの出所）';


--
-- Name: tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    case_id uuid NOT NULL,
    tkt_no text NOT NULL,
    inc_no text NOT NULL,
    assignee_id uuid,
    status text DEFAULT 'queued'::text NOT NULL,
    handoff_memo text DEFAULT ''::text NOT NULL,
    shared_fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tickets_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'assigned'::text, 'in_progress'::text, 'resolved'::text, 'closed'::text])))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    role text NOT NULL,
    password_hash text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['requester'::text, 'helpdesk'::text, 'approver'::text])))
);


--
-- Name: audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);


--
-- Name: case_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_messages ALTER COLUMN id SET DEFAULT nextval('public.case_messages_id_seq'::regclass);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: case_handover_notifications case_handover_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_handover_notifications
    ADD CONSTRAINT case_handover_notifications_pkey PRIMARY KEY (id);


--
-- Name: case_handovers case_handovers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_handovers
    ADD CONSTRAINT case_handovers_pkey PRIMARY KEY (id);


--
-- Name: case_messages case_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_messages
    ADD CONSTRAINT case_messages_pkey PRIMARY KEY (id);


--
-- Name: cases cases_case_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_case_no_key UNIQUE (case_no);


--
-- Name: cases cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_pkey PRIMARY KEY (id);


--
-- Name: device_commands device_commands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_commands
    ADD CONSTRAINT device_commands_pkey PRIMARY KEY (id);


--
-- Name: device_inventories device_inventories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_inventories
    ADD CONSTRAINT device_inventories_pkey PRIMARY KEY (user_email, source, device_id);


--
-- Name: device_mesh_links device_mesh_links_device_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_mesh_links
    ADD CONSTRAINT device_mesh_links_device_id_key UNIQUE (device_id);


--
-- Name: device_mesh_links device_mesh_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_mesh_links
    ADD CONSTRAINT device_mesh_links_pkey PRIMARY KEY (id);


--
-- Name: device_tokens device_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_tokens
    ADD CONSTRAINT device_tokens_pkey PRIMARY KEY (token_hash);


--
-- Name: final_reports final_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.final_reports
    ADD CONSTRAINT final_reports_pkey PRIMARY KEY (id);


--
-- Name: knowledge knowledge_kb_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge
    ADD CONSTRAINT knowledge_kb_no_key UNIQUE (kb_no);


--
-- Name: knowledge knowledge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge
    ADD CONSTRAINT knowledge_pkey PRIMARY KEY (id);


--
-- Name: knowledge knowledge_resolution_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge
    ADD CONSTRAINT knowledge_resolution_id_key UNIQUE (resolution_id);


--
-- Name: knowledge_reviews knowledge_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_reviews
    ADD CONSTRAINT knowledge_reviews_pkey PRIMARY KEY (id);


--
-- Name: mesh_install_requests mesh_install_requests_case_id_rsp_device_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mesh_install_requests
    ADD CONSTRAINT mesh_install_requests_case_id_rsp_device_id_key UNIQUE (case_id, rsp_device_id);


--
-- Name: mesh_install_requests mesh_install_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mesh_install_requests
    ADD CONSTRAINT mesh_install_requests_pkey PRIMARY KEY (id);


--
-- Name: pc_snapshots pc_snapshots_case_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pc_snapshots
    ADD CONSTRAINT pc_snapshots_case_id_key UNIQUE (case_id);


--
-- Name: pc_snapshots pc_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pc_snapshots
    ADD CONSTRAINT pc_snapshots_pkey PRIMARY KEY (id);


--
-- Name: prototype_states prototype_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prototype_states
    ADD CONSTRAINT prototype_states_pkey PRIMARY KEY (user_email, name);


--
-- Name: resolution_sessions resolution_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resolution_sessions
    ADD CONSTRAINT resolution_sessions_pkey PRIMARY KEY (id);


--
-- Name: resolution_steps resolution_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resolution_steps
    ADD CONSTRAINT resolution_steps_pkey PRIMARY KEY (id);


--
-- Name: resolution_steps resolution_steps_session_id_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resolution_steps
    ADD CONSTRAINT resolution_steps_session_id_seq_key UNIQUE (session_id, seq);


--
-- Name: resolutions resolutions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resolutions
    ADD CONSTRAINT resolutions_pkey PRIMARY KEY (id);


--
-- Name: resolutions resolutions_ticket_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resolutions
    ADD CONSTRAINT resolutions_ticket_id_key UNIQUE (ticket_id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: skills skills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_pkey PRIMARY KEY (id, version);


--
-- Name: terminal_sessions terminal_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminal_sessions
    ADD CONSTRAINT terminal_sessions_pkey PRIMARY KEY (id);


--
-- Name: terminal_steps terminal_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminal_steps
    ADD CONSTRAINT terminal_steps_pkey PRIMARY KEY (id);


--
-- Name: terminal_steps terminal_steps_session_id_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminal_steps
    ADD CONSTRAINT terminal_steps_session_id_seq_key UNIQUE (session_id, seq);


--
-- Name: tickets tickets_case_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_case_id_key UNIQUE (case_id);


--
-- Name: tickets tickets_inc_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_inc_no_key UNIQUE (inc_no);


--
-- Name: tickets tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_pkey PRIMARY KEY (id);


--
-- Name: tickets tickets_tkt_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_tkt_no_key UNIQUE (tkt_no);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: audit_log_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_created_idx ON public.audit_log USING btree (created_at DESC);


--
-- Name: audit_log_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_target_idx ON public.audit_log USING btree (target_type, target_id);


--
-- Name: case_handover_notifications_handover_recipient_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX case_handover_notifications_handover_recipient_idx ON public.case_handover_notifications USING btree (handover_id, recipient_email);


--
-- Name: case_handover_notifications_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX case_handover_notifications_pending_idx ON public.case_handover_notifications USING btree (status, created_at);


--
-- Name: case_handovers_active_case_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX case_handovers_active_case_idx ON public.case_handovers USING btree (case_id, owner_email) WHERE (status = ANY (ARRAY['pending'::text, 'claimed'::text]));


--
-- Name: case_handovers_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX case_handovers_status_created_idx ON public.case_handovers USING btree (status, created_at);


--
-- Name: case_messages_case_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX case_messages_case_idx ON public.case_messages USING btree (case_id, created_at);


--
-- Name: cases_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cases_created_idx ON public.cases USING btree (created_at DESC);


--
-- Name: cases_requester_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cases_requester_idx ON public.cases USING btree (requester_id, created_at DESC);


--
-- Name: cases_signal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cases_signal_idx ON public.cases USING btree (signal);


--
-- Name: cases_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cases_status_idx ON public.cases USING btree (status, updated_at DESC);


--
-- Name: device_commands_email_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_commands_email_status_idx ON public.device_commands USING btree (user_email, status, created_at);


--
-- Name: device_commands_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_commands_session_idx ON public.device_commands USING btree (session_id);


--
-- Name: device_inventories_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_inventories_email_idx ON public.device_inventories USING btree (user_email, collected_at DESC);


--
-- Name: device_mesh_links_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_mesh_links_user_idx ON public.device_mesh_links USING btree (user_email, created_at DESC);


--
-- Name: device_tokens_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_tokens_email_idx ON public.device_tokens USING btree (user_email);


--
-- Name: final_reports_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX final_reports_user_created_idx ON public.final_reports USING btree (user_email, created_at DESC);


--
-- Name: knowledge_case_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_case_idx ON public.knowledge USING btree (case_id);


--
-- Name: knowledge_keywords_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_keywords_gin ON public.knowledge USING gin (keywords);


--
-- Name: knowledge_reviews_kb_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_reviews_kb_idx ON public.knowledge_reviews USING btree (knowledge_id, created_at);


--
-- Name: knowledge_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_status_idx ON public.knowledge USING btree (status, updated_at DESC);


--
-- Name: mesh_install_requests_case_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mesh_install_requests_case_idx ON public.mesh_install_requests USING btree (case_id, requested_at DESC);


--
-- Name: prototype_states_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prototype_states_email_idx ON public.prototype_states USING btree (user_email);


--
-- Name: resolution_sessions_case_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resolution_sessions_case_idx ON public.resolution_sessions USING btree (case_id);


--
-- Name: resolution_sessions_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resolution_sessions_email_idx ON public.resolution_sessions USING btree (user_email, created_at DESC);


--
-- Name: resolution_steps_admin_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resolution_steps_admin_pending_idx ON public.resolution_steps USING btree (risk_level, created_at) WHERE ((status = 'proposed'::text) AND (risk_level >= 4));


--
-- Name: resolution_steps_command_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resolution_steps_command_idx ON public.resolution_steps USING btree (command_id);


--
-- Name: resolution_steps_deadline_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resolution_steps_deadline_idx ON public.resolution_steps USING btree (status, deadline_at) WHERE (status = ANY (ARRAY['approved'::text, 'executing'::text]));


--
-- Name: resolution_steps_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resolution_steps_session_idx ON public.resolution_steps USING btree (session_id, seq);


--
-- Name: resolution_steps_verify_for_step_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX resolution_steps_verify_for_step_uidx ON public.resolution_steps USING btree (verify_for_step_id) WHERE (verify_for_step_id IS NOT NULL);


--
-- Name: resolutions_case_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resolutions_case_idx ON public.resolutions USING btree (case_id);


--
-- Name: sessions_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_expires_idx ON public.sessions USING btree (expires_at);


--
-- Name: sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_id);


--
-- Name: skills_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX skills_status_idx ON public.skills USING btree (status, id);


--
-- Name: terminal_sessions_active_handover_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX terminal_sessions_active_handover_uidx ON public.terminal_sessions USING btree (handover_id) WHERE ((status = 'active'::text) AND (handover_id IS NOT NULL));


--
-- Name: terminal_sessions_case_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX terminal_sessions_case_idx ON public.terminal_sessions USING btree (case_id, started_at DESC);


--
-- Name: terminal_sessions_rsp_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX terminal_sessions_rsp_session_idx ON public.terminal_sessions USING btree (rsp_session_id);


--
-- Name: terminal_steps_rsp_command_log_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX terminal_steps_rsp_command_log_idx ON public.terminal_steps USING btree (rsp_command_log_id);


--
-- Name: terminal_steps_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX terminal_steps_session_idx ON public.terminal_steps USING btree (session_id, seq);


--
-- Name: tickets_assignee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tickets_assignee_idx ON public.tickets USING btree (assignee_id, status);


--
-- Name: tickets_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tickets_status_idx ON public.tickets USING btree (status, created_at);


--
-- Name: users_email_lower_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_lower_uq ON public.users USING btree (lower(email));


--
-- Name: cases cases_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cases_updated_at BEFORE UPDATE ON public.cases FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: knowledge knowledge_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER knowledge_updated_at BEFORE UPDATE ON public.knowledge FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: tickets tickets_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tickets_updated_at BEFORE UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: users users_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: audit_log audit_log_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id);


--
-- Name: case_handover_notifications case_handover_notifications_handover_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_handover_notifications
    ADD CONSTRAINT case_handover_notifications_handover_id_fkey FOREIGN KEY (handover_id) REFERENCES public.case_handovers(id) ON DELETE CASCADE;


--
-- Name: case_messages case_messages_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_messages
    ADD CONSTRAINT case_messages_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id);


--
-- Name: case_messages case_messages_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_messages
    ADD CONSTRAINT case_messages_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: cases cases_requester_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES public.users(id);


--
-- Name: knowledge knowledge_approver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge
    ADD CONSTRAINT knowledge_approver_id_fkey FOREIGN KEY (approver_id) REFERENCES public.users(id);


--
-- Name: knowledge knowledge_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge
    ADD CONSTRAINT knowledge_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id);


--
-- Name: knowledge knowledge_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge
    ADD CONSTRAINT knowledge_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE SET NULL;


--
-- Name: knowledge knowledge_resolution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge
    ADD CONSTRAINT knowledge_resolution_id_fkey FOREIGN KEY (resolution_id) REFERENCES public.resolutions(id) ON DELETE SET NULL;


--
-- Name: knowledge_reviews knowledge_reviews_knowledge_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_reviews
    ADD CONSTRAINT knowledge_reviews_knowledge_id_fkey FOREIGN KEY (knowledge_id) REFERENCES public.knowledge(id) ON DELETE CASCADE;


--
-- Name: knowledge_reviews knowledge_reviews_reviewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_reviews
    ADD CONSTRAINT knowledge_reviews_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES public.users(id);


--
-- Name: mesh_install_requests mesh_install_requests_resolve_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mesh_install_requests
    ADD CONSTRAINT mesh_install_requests_resolve_session_id_fkey FOREIGN KEY (resolve_session_id) REFERENCES public.resolution_sessions(id) ON DELETE SET NULL;


--
-- Name: pc_snapshots pc_snapshots_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pc_snapshots
    ADD CONSTRAINT pc_snapshots_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: resolution_steps resolution_steps_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resolution_steps
    ADD CONSTRAINT resolution_steps_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.resolution_sessions(id) ON DELETE CASCADE;


--
-- Name: resolutions resolutions_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resolutions
    ADD CONSTRAINT resolutions_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id);


--
-- Name: resolutions resolutions_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resolutions
    ADD CONSTRAINT resolutions_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: resolutions resolutions_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resolutions
    ADD CONSTRAINT resolutions_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: terminal_sessions terminal_sessions_handover_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminal_sessions
    ADD CONSTRAINT terminal_sessions_handover_id_fkey FOREIGN KEY (handover_id) REFERENCES public.case_handovers(id) ON DELETE SET NULL;


--
-- Name: terminal_sessions terminal_sessions_knowledge_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminal_sessions
    ADD CONSTRAINT terminal_sessions_knowledge_id_fkey FOREIGN KEY (knowledge_id) REFERENCES public.knowledge(id) ON DELETE SET NULL;


--
-- Name: terminal_steps terminal_steps_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.terminal_steps
    ADD CONSTRAINT terminal_steps_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.terminal_sessions(id) ON DELETE CASCADE;


--
-- Name: tickets tickets_assignee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES public.users(id);


--
-- Name: tickets tickets_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict h1CLXRJ2Rdi3eDyHgpaz1XagEABaWf7jBbPRO73vrwDZJMZjEQqKAZYLVg34oqX

