/*
 * AI HelpDesk assist bridge（最終報告書 + 遠隔支援コンソール）
 *
 * 既存プロトタイプ HTML は変更しない。このブリッジだけを追加する。
 * - STEP 3（AIで解決）/ STEP 5（担当者対応で解決）の完了時に、
 *   Standalone HTML / PDF の最終報告書を出力する。
 * - STEP 5 の引継ぎ後に、担当者（Bさん）が本人（Aさん）の同意を得て
 *   案内文を送る「遠隔支援コンソール」を追加する。
 *   画面の遠隔操作は RSP 側で行い、このブリッジは同意・案内・記録を扱う。
 *   画面録画は行わない（端末操作のログは RSP のコマンド実行履歴に残る）。
 *
 * 依存: paneHtml / wizSoft / uxRender / curCase / link / me / isHdRole など
 * （同じ classic script のグローバル lexical 環境から参照する）
 */
(() => {
  if (window.__AIHD_ASSIST_BRIDGE__) return;
  // rspDeepLink は純粋な URL 生成関数で、状態も秘密も持たない。
  // 画面からは使わず、単体テスト (assist-bridge.test.ts) の検証点として公開する。
  window.__AIHD_ASSIST_BRIDGE__ = {
    version: 2,
    at: new Date().toISOString(),
    rspDeepLink: (c) => ahRspDeepLink(c),
    // 画面内の KB を「承認済み」と表示するかの判定の単体テスト用。
    labelHdKb: (items, drafts, refs) => ahLabelHdKb(items, drafts, refs),
    kbIsDbApproved: (kb, drafts, refs) => ahKbIsDbApproved(kb, drafts, refs),
    // 引継ぎの承認と KB 公開を分ける処理の単体テスト用。
    handoverApprovalNotice: (approved, kb) => ahHandoverApprovalNotice(approved, kb),
    publishKnowledgeAfterHandover: (full, checklist, comment) =>
      ahPublishKnowledgeAfterHandover(full, checklist, comment),
    // F-13 の単体テスト用（DOM に依存しない純粋関数）。
    applyHandoverStatus: (c, handover) => ahApplyHandoverStatus(c, handover),
    linkWithHandover: (c, L) => ahLinkWithHandover(c, L),
    // F-13 追記: 完了案件の承認情報表示（STEP7）の単体テスト用。
    approvalNoteHtml: (c) => ahApprovalNoteHtml(c),
    // F-06 不足分（承認者向けサーバ下書き）の単体テスト用。
    pendingApprovePayload: (item, checklist, comment) =>
      ahPendingApprovePayload(item, checklist, comment),
    pendingRejectPayload: (item, reason) => ahPendingRejectPayload(item, reason),
    pendingSectionHtml: (items, errorCode) => ahPendingSectionHtml(items, errorCode),
    // 相談者の画面が受信箱を呼ばないことの単体テスト用（staff-access.test.ts）。
    fetchHandoverInbox: () => ahFetchHandoverInbox(),
    // 報告書へ渡す内容の確認用（scripts/e2e/wizard-real-path.mjs）。
    reportPayload: (c, L) => ahReportPayload(c, L),
  };

  const AH = {
    busy: null,
    remoteDrafting: false,
    draft: null,
    intent: '',
    injecting: false,
    handoverInbox: [],
    handoverLoaded: false,
    handoverLoading: false,
    recipients: [],
    recipientsLoaded: false,
    recipientsLoading: false,
    shareOpen: false,
    approving: false,
    caseAiBusy: false,
    handoverStatusSyncing: false,
    handoverStatusSyncedAt: 0,
    // F-06 不足分: 承認者向けサーバ下書き（GET /api/knowledge/pending）
    pending: [],
    pendingLoaded: false,
    pendingLoadedAt: 0,
    pendingError: '',
    pendingBusy: false,
    // GET /api/knowledge/approved-refs の結果。null の間は承認済みと表示しない。
    kbRefs: null,
  };
  window.__AIHD_ASSIST__ = AH;

  const ahBoot = window.__AIHD_BOOT__ || {};
  const ahMeshUrl = String(ahBoot.meshcentralUrl || 'https://mesh.mirai-remotetools.com/');
  const ahRspUrl = String(ahBoot.rspBaseUrl || 'https://rsp.mirai-remotetools.com/');

  const ahEsc = (value) =>
    String(value == null ? '' : value).replace(/[&<>"']/g, (char) => {
      return (
        {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        }[char] || char
      );
    });

  /** メール・電話・IP・カード・資産番号を伏せ字化する（保存前の防御）。 */
  const ahMaskPII = (value) => {
    return String(value == null ? '' : value)
      .replace(/[A-Z0-9._%+-]+[@＠][A-Z0-9.-]+\.[A-Z]{2,}/gi, '[メールアドレス]')
      .replace(/(?<!\d)0\d{1,4}[-‐－ 　]?\d{1,4}[-‐－ 　]?\d{3,4}(?!\d)/g, '[電話番号]')
      .replace(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, '[IPアドレス]')
      .replace(/(?<!\d)(?:\d[ -]?){13,16}(?!\d)/g, '[カード番号]')
      .replace(/(?<![A-Z0-9])(?:PC|NB|SV)[-_]?\d{3,6}(?![A-Z0-9])/gi, '[資産番号]');
  };

  const ahNow = () => new Date().toISOString();
  const ahAfter = (ms) => new Date(Date.now() + ms).toISOString();
  const ahFmt = (value) =>
    String(value || '')
      .replace('T', ' ')
      .replace(/\.\d+Z?$/, '')
      .replace(/\+00:00$/, '')
      .slice(0, 16);

  function ahUser() {
    try {
      return me();
    } catch (error) {
      return null;
    }
  }

  function ahName(id) {
    try {
      // 名簿に無い利用者はデモ人物に固定されている。その氏名を報告書へ書かない。
      if (typeof PERSONA_LOCKED !== 'undefined' && PERSONA_LOCKED && id === S.ui.user) {
        return '名簿未登録の利用者（氏名は未確認）';
      }
      return uname(id);
    } catch (error) {
      return String(id || '');
    }
  }

  function ahModel() {
    try {
      if (typeof MODELS !== 'undefined' && MODELS && MODELS[S.ui.model]) return MODELS[S.ui.model];
    } catch (error) {
      // ignore
    }
    return 'DeepSeek-V4.1-Flash';
  }

  /** honest-labels-bridge.js の判定。読み込めない文脈では何もしない。 */
  function ahHonest() {
    return typeof window !== 'undefined' && window.__AIHD_HONEST__ ? window.__AIHD_HONEST__ : null;
  }

  /** 報告書のモデル欄。実 AI の回答が無い相談に DeepSeek と書かない。 */
  function ahReportModel(chat) {
    const honest = ahHonest();
    return honest ? honest.reportModel(chat) : ahModel();
  }

  function ahKindLabel(c) {
    try {
      const kind = kindOf(c.kind);
      if (kind && kind.t) return kind.t;
    } catch (error) {
      // ignore
    }
    return 'その他・相談';
  }

  function ahCompleted(c, L) {
    if (!c) return false;
    if (c.closed === 'ai') return true;
    if (L && L.kb) return true;
    if (L && L.inc && L.inc.status === 'resolved') return true;
    if (L && L.tkt && L.tkt.status === '解決') return true;
    return false;
  }

  function ahReportKind(c, L) {
    if (c.closed === 'ai') return 'ai_resolved';
    if (L && (L.kb || (L.inc && L.inc.status === 'resolved'))) return 'helpdesk_resolved';
    return 'helpdesk_resolved';
  }

  function ahCanExport(c) {
    const u = ahUser();
    if (!u) return false;
    return u.id === c.userId || isHdRole(u);
  }

  function ahStripHtml(html) {
    return String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|div|h[1-6]|tr|section)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function ahMessageText(message) {
    if (!message) return '';
    if (message.text) return String(message.text);
    if (message.kind === 'kb') return message.aiText || '社内資料を提示しました。';
    if (message.kind === 'diag') return message.title || '端末を診断しました。';
    if (message.kind === 'block') {
      return [message.title, ahStripHtml(message.html)].filter(Boolean).join('\n');
    }
    if (message.kind === 'proposal') {
      const proposal = S.proposals[message.propId];
      return proposal ? '修復を提案しました：' + proposal.opId : '修復を提案しました。';
    }
    if (message.kind === 'exec') {
      const stateLabel = {
        done: '実行しました',
        denied: '実行しませんでした',
        failed: '失敗しました',
        aborted: '中断しました',
      };
      return stateLabel[message.state] || '実行結果を記録しました。';
    }
    if (message.kind === 'ticket') return '担当者へ引き継ぎました。';
    if (message.kind === 'consent') return '共有する情報を確認しました。';
    if (message.kind === 'confirm') return message.text || '内容を確認しました。';
    return ahStripHtml(message.html);
  }

  function ahPcPayload(c) {
    const s = c.pc && c.pc.state === 'done' ? c.pc.snap : null;
    if (!s) return { available: false, itemCount: 0, flags: [], items: [] };
    // 固定データのスナップショットは実端末の情報として報告書へ載せない。
    if (ahHonest() && ahHonest().isDemoSnapshot(s)) {
      return { available: false, itemCount: 0, flags: [], items: [] };
    }
    let visible = false;
    try {
      visible = pcVisible(c);
    } catch (error) {
      visible = false;
    }
    const flags = pcFlags(s, (c.subject || '') + ' ' + (c.body || ''));
    const mapItem = (item) => ({
      grp: String(item.grp || ''),
      k: String(item.k || ''),
      v: String(item.v || ''),
      lv: item.lv === 'warn' || item.lv === 'ng' ? item.lv : 'ok',
      note: item.note ? String(item.note) : undefined,
      rel: Boolean(item.rel),
    });
    return {
      available: visible,
      device: s.device,
      collectedAt: s.at,
      itemCount: s.items.length,
      shared: Boolean(c.share && c.share.pc !== false),
      flags: flags.map(mapItem),
      items: visible ? s.items.map(mapItem) : [],
    };
  }

  function ahPcSummary(c) {
    try {
      if (!pcVisible(c)) return '';
      return pcLines(c).join('\n').slice(0, 4000);
    } catch (error) {
      return '';
    }
  }

  function ahChatOf(c) {
    if (!c.chatId) return null;
    return S.chats.find((chat) => chat.id === c.chatId) || null;
  }

  function ahMessages(c, chat) {
    if (!chat) return [];
    const out = [];
    for (const message of chat.messages) {
      if (!message || message.kind === 'welcome') continue;
      const at = ahFmt(message.at);
      if (message.kind === 'user') {
        out.push({
          at,
          role: 'user',
          who: ahName(c.userId),
          text: ahMessageText(message).slice(0, 12000),
        });
      } else if (message.kind === 'ai' || message.kind === 'block') {
        const text = ahMessageText(message).slice(0, 12000);
        const who = message.who || (ahHonest() ? ahHonest().whoFor(message) : 'AI');
        if (text) out.push({ at, role: 'ai', who, text });
      } else if (message.kind === 'kb') {
        out.push({
          at,
          role: 'ai',
          who: ahHonest() ? ahHonest().whoFor(message) : 'AI',
          text: (message.aiText || '社内資料を提示しました。').slice(0, 12000),
          kbId: message.kbId,
          score: typeof message.score === 'number' ? message.score : undefined,
        });
      } else if (message.kind === 'ticket') {
        const ticket = S.tickets.find((item) => item.id === message.ticketId);
        out.push({
          at,
          role: 'system',
          who: 'システム',
          text:
            '担当者へ引き継ぎました' +
            (ticket ? '（' + ticket.id + (ticket.incId ? ' → ' + ticket.incId : '') + '）' : ''),
        });
      } else if (message.kind === 'consent') {
        out.push({
          at,
          role: 'system',
          who: 'システム',
          text:
            message.state === 'sent'
              ? '本人が共有に同意して引き継ぎました。'
              : '引継ぎの同意待ちです。',
        });
      } else if (message.kind === 'confirm') {
        out.push({
          at,
          role: 'user',
          who: ahName(c.userId),
          text: message.text || '内容を確認しました。',
        });
      }
    }
    return out.slice(-200);
  }

  function ahDiagnoses(chat) {
    if (!chat) return [];
    return chat.messages
      .filter((message) => message.kind === 'diag' || message.resolveResult)
      .slice(-50)
      .map((message) => {
        // 解決ループの結果は出所（実端末 / 模擬 / 不明）を題名に付けて、そのまま載せる。
        if (message.resolveResult) {
          const result = message.resolveResult;
          return {
            title: `${message.model || ''}：${result.title || result.skillId || '読み取り診断'}`,
            rows: (result.facts || []).map(([key, value]) => ({
              k: String(key),
              v: String(value),
              // 値を判定していないので「正常」と書かない。
              lv: 'none',
            })),
          };
        }
        return {
          // 診断は固定データ。報告書でも実端末の結果に見せない。
          title:
            (ahHonest() ? ahHonest().DEMO_PREFIX : '') +
            (message.title || '端末の診断（読み取りのみ）'),
          rows: (message.steps || []).map((step) => ({
            k: String(step[0] || ''),
            v: String(step[1] || ''),
            lv: step[2] === 'warn' || step[2] === 'ng' ? step[2] : 'ok',
          })),
        };
      });
  }

  function ahProposals(chat) {
    if (!chat) return [];
    const out = [];
    for (const message of chat.messages) {
      if (message.kind !== 'proposal') continue;
      const proposal = S.proposals[message.propId];
      if (!proposal) continue;
      const op = (typeof OPS !== 'undefined' && OPS[proposal.opId]) || {};
      const state = (typeof PST !== 'undefined' && PST[proposal.status]) || [];
      out.push({
        opId: proposal.opId,
        name: ((ahHonest() ? ahHonest().DEMO_PREFIX : '') + (op.name || proposal.opId)).slice(
          0,
          200,
        ),
        level: op.level,
        impact: op.impact ? String(op.impact).slice(0, 1000) : undefined,
        rollback: op.rollback ? String(op.rollback).slice(0, 1000) : undefined,
        status: state[0] || proposal.status,
        result:
          proposal.result && proposal.result.file
            ? '作成ファイル：' + proposal.result.file.name
            : undefined,
      });
    }
    return out.slice(-50);
  }

  function ahSources(chat) {
    if (!chat) return [];
    const map = new Map();
    for (const message of chat.messages) {
      if (message.kind !== 'kb') continue;
      for (const id of message.hits || []) {
        if (map.has(id)) continue;
        let kb = null;
        try {
          kb = kbById(S, id);
        } catch (error) {
          kb = null;
        }
        if (kb)
          map.set(id, { id: kb.id, kbNo: kb.id, title: String(kb.title || '').slice(0, 300) });
      }
    }
    return Array.from(map.values()).slice(0, 50);
  }

  function ahTimeline(c, L, chat) {
    const out = [];
    const push = (at, actor, action, detail) => {
      if (!action) return;
      out.push({
        at: ahFmt(at),
        actor: String(actor || ''),
        action: String(action).slice(0, 300),
        detail: detail ? String(detail).slice(0, 2000) : undefined,
      });
    };
    push(c.created, ahName(c.userId), '相談を送信', c.subject || '');
    if (chat) {
      for (const message of chat.messages) {
        if (!message || message.kind === 'welcome') continue;
        if (message.kind === 'diag')
          push(message.at, 'AI', '端末を診断（読み取りのみ）', message.title || '');
        if (message.resolveResult)
          push(
            message.at,
            message.model || '',
            '端末の読み取り結果',
            message.resolveResult.title || '',
          );
        if (message.kind === 'kb') push(message.at, 'AI', 'ナレッジを提示', message.kbId || '');
        if (message.kind === 'proposal') push(message.at, 'AI', '修復を提案', message.propId || '');
        if (message.kind === 'exec')
          push(message.at, 'PCエージェント', '修復の実行結果', message.state || '');
        if (message.kind === 'ticket')
          push(message.at, 'システム', '担当者へ引き継ぎ', message.ticketId || '');
        if (message.kind === 'consent' && message.state === 'sent') {
          push(message.at, ahName(c.userId), '共有に同意', '本人が共有範囲を確認');
        }
      }
    }
    if (c.closed === 'ai')
      push(c.closedAt || c.created, 'AI', 'AIの一次対応で解決', '担当者への引継ぎなし');
    const tkt = L && L.tkt;
    const inc = L && L.inc;
    if (tkt) {
      push(
        tkt.created,
        'システム',
        '担当者へ引き継ぎ',
        tkt.id + (tkt.incId ? ' → ' + tkt.incId : ''),
      );
      for (const history of tkt.history || []) {
        if (!history || !history.text) continue;
        push(history.at, history.by === 'system' ? 'システム' : history.by, history.text, '');
      }
    }
    if (inc) {
      if (inc.assignee)
        push(
          inc.startedAt || inc.escalatedAt || (tkt && tkt.created),
          inc.assignee,
          '担当者が対応開始',
          '',
        );
      if (inc.status === 'resolved') {
        push(
          inc.resolvedAt || (tkt && tkt.created),
          inc.assignee || '担当者',
          '担当者が解決',
          inc.resolution && inc.resolution.cause,
        );
      }
      if (inc.kbId)
        push(
          inc.resolvedAt || (tkt && tkt.created),
          inc.assignee || '担当者',
          'ナレッジとして承認',
          inc.kbId,
        );
    }
    if (c.remote) {
      const remote = c.remote;
      if (remote.requestedAt)
        push(remote.requestedAt, remote.requestedBy || '担当者', '遠隔支援を依頼', '');
      if (remote.approvedAt)
        push(remote.approvedAt, ahName(c.userId), '遠隔支援を承認', '読み取り情報と案内文のみ');
      for (const prompt of remote.prompts || []) {
        push(prompt.at, prompt.by || '担当者', '本人へ案内を送信', prompt.text);
        if (prompt.doneAt)
          push(
            prompt.doneAt,
            ahName(c.userId),
            prompt.status === 'done' ? '案内を実施' : '案内を実施できず',
            '',
          );
      }
      if (remote.endedAt) push(remote.endedAt, '', '遠隔支援を終了', '');
    }
    for (const event of S.audit || []) {
      const detail = event.detail || {};
      if (
        detail.case !== c.id &&
        (!tkt || detail.ticket !== tkt.id) &&
        (!inc || detail.inc !== inc.id)
      )
        continue;
      if (
        [
          'case_created',
          'ticket_created',
          'hd_linked',
          'resolved_by_ai',
          'pcinfo_collected',
          // 遠隔支援は c.remote から、報告書出力は report_exported を別途扱うため、
          // 監査ログ側の同じ出来事はタイムラインで重複させない。
          'remote_requested',
          'remote_approved',
          'remote_denied',
          'remote_ended',
          'remote_expired',
          'remote_prompt_sent',
          'remote_prompt_done',
          'remote_prompt_failed',
          'report_exported',
        ].includes(event.event)
      )
        continue;
      push(
        event.ts,
        ahName(event.actor),
        (typeof EV !== 'undefined' && EV[event.event]) || event.event,
        '',
      );
    }
    out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return out.slice(-300);
  }

  function ahReportPayload(c, L) {
    const chat = ahChatOf(c);
    const tkt = L && L.tkt;
    const inc = L && L.inc;
    const dr = L && L.dr;
    const kb = L && L.kb;
    const requester = (typeof USERS !== 'undefined' && USERS[c.userId]) || {};
    const dept =
      requester.dept && typeof DEPTS !== 'undefined' && DEPTS[requester.dept]
        ? DEPTS[requester.dept].name
        : '';
    const actor = ahUser() || {};
    const actorDept =
      actor.dept && typeof DEPTS !== 'undefined' && DEPTS[actor.dept] ? DEPTS[actor.dept].name : '';
    const sharedKeys = tkt && tkt.shared ? Object.keys(tkt.shared) : [];
    const handoverReason = (() => {
      if (c.closed === 'ai') return '';
      if (tkt && tkt.history) {
        const found = tkt.history.find(
          (item) => item && /引継ぎ|引き継ぎ|連携/.test(item.text || ''),
        );
        if (found && found.text) return found.text;
      }
      return c.kind === 'sec'
        ? 'セキュリティ事象のため担当者へ'
        : 'AIの一次対応で解決しないため、本人の同意を得て引き継ぎ';
    })();

    return {
      reportVersion: 1,
      kind: ahReportKind(c, L),
      generatedAt: ahNow(),
      generatedBy: {
        name: actor.name || '不明',
        role: (typeof ROLES !== 'undefined' && ROLES[actor.role]) || actor.role || '',
        dept: actorDept,
        employeeNo: actor.employeeNo || undefined,
      },
      requester: {
        name: requester.name || ahName(c.userId),
        dept,
        employeeNo: requester.employeeNo || undefined,
      },
      case: {
        id: c.id,
        created: c.created,
        kindLabel: ahKindLabel(c),
        subject: (c.subject || '(件名なし)').slice(0, 500),
        body: (c.body || '').slice(0, 12000),
        urgency: c.urg || '通常',
        model: ahReportModel(chat),
        step: c.step || 7,
      },
      pc: ahPcPayload(c),
      ai: {
        // bridge.js が AI メッセージに保存した provider（deepseek / fallback）だけを使う。
        // 判定できない場合は表示しない（報告書で生成元を過大に主張しない）。
        provider: (() => {
          if (!chat) return undefined;
          const found = chat.messages.find(
            (message) => message.provider === 'deepseek' || message.provider === 'fallback',
          );
          return found ? found.provider : undefined;
        })(),
        model: ahReportModel(chat),
        messages: ahMessages(c, chat),
        diagnoses: ahDiagnoses(chat),
        proposals: ahProposals(chat),
        sources: ahSources(chat),
      },
      handover: tkt
        ? {
            reason: handoverReason,
            ticketId: tkt.id,
            incId: tkt.incId || undefined,
            assignee: (inc && inc.assignee) || tkt.assigneeLabel || tkt.assignee || undefined,
            shared: sharedKeys,
            memo: String((inc && inc.handover) || '').slice(0, 20000),
            at: tkt.created,
          }
        : null,
      resolution:
        inc && inc.resolution
          ? {
              cause: String(inc.resolution.cause || '').slice(0, 4000),
              steps: (inc.resolution.steps || []).map((step) => String(step).slice(0, 4000)),
              minutes:
                typeof inc.resolution.minutes === 'number' ? inc.resolution.minutes : undefined,
              by: inc.resolution.by || inc.assignee || '',
            }
          : null,
      knowledge:
        dr || kb
          ? {
              draftId: dr ? dr.id : undefined,
              status: dr ? dr.status : undefined,
              kbId: kb ? kb.id : dr ? dr.kbId : undefined,
              title: kb ? kb.title : undefined,
              version: kb ? kb.version : undefined,
              approvedBy: kb ? kb.approvedBy : undefined,
            }
          : null,
      remote: c.remote
        ? {
            status: c.remote.status,
            requestedBy: c.remote.requestedBy,
            requestedAt: c.remote.requestedAt,
            approvedBy: c.remote.approvedBy,
            approvedAt: c.remote.approvedAt,
            endedAt: c.remote.endedAt,
            expiresAt: c.remote.expiresAt,
            scope: c.remote.scope,
            prompts: (c.remote.prompts || []).map((prompt) => ({
              at: prompt.at,
              by: prompt.by,
              text: prompt.text,
              status: prompt.status || 'sent',
              doneAt: prompt.doneAt,
            })),
          }
        : null,
      timeline: ahTimeline(c, L, chat),
    };
  }

  function ahApiError(response) {
    return response
      .json()
      .then((data) => (data && data.error && data.error.message) || 'HTTP ' + response.status)
      .catch(() => 'HTTP ' + response.status);
  }

  function ahDownloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename || 'report';
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      anchor.remove();
    }, 1500);
  }

  async function ahExport(c, format) {
    if (AH.busy) return;
    const L = link(c);
    if (!ahCompleted(c, L)) {
      if (typeof toast === 'function') toast('完了した案件だけ最終報告書を出力できます');
      return;
    }
    if (!ahCanExport(c)) {
      if (typeof toast === 'function') toast('この案件の報告書を出力する権限がありません', 'bad');
      return;
    }
    AH.busy = format;
    uxRender();
    try {
      const report = ahReportPayload(c, L);
      const response = await fetch('/api/reports/final', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report }),
      });
      if (!response.ok) throw new Error(await ahApiError(response));
      const data = await response.json();
      let file = data && data.report && data.report.files && data.report.files[format];
      if (!file) throw new Error('出力先が返されませんでした');
      let actualFormat = format;
      let fileResponse = await fetch(file.url);
      if (!fileResponse.ok && format === 'pdf') {
        // PDF 生成不可（503 など）のときは、同じ報告書の HTML へ自動フォールバックする。
        const pdfError = await ahApiError(fileResponse);
        const htmlFile = data.report.files.html;
        if (htmlFile) {
          const fallbackResponse = await fetch(htmlFile.url);
          if (fallbackResponse.ok) {
            file = htmlFile;
            actualFormat = 'html';
            fileResponse = fallbackResponse;
          } else {
            throw new Error(pdfError);
          }
        } else {
          throw new Error(pdfError);
        }
      }
      if (!fileResponse.ok) throw new Error(await ahApiError(fileResponse));
      ahDownloadBlob(await fileResponse.blob(), file.filename);
      const previous = c._report && Array.isArray(c._report.formats) ? c._report.formats : [];
      c._report = {
        id: data.report.id,
        sha256: data.report.sha256,
        at: ahNow(),
        formats: previous
          .filter((value) => value !== actualFormat)
          .concat(actualFormat)
          .slice(-3),
      };
      if (typeof auditAdd === 'function') {
        auditAdd(S, (ahUser() || {}).id || 'system', 'report_exported', {
          case: c.id,
          kind: report.kind,
          format: actualFormat,
          reportId: data.report.id,
          sha256: data.report.sha256,
        });
      }
      save();
      if (typeof toast === 'function') {
        toast(
          actualFormat === 'pdf'
            ? 'PDF を出力しました（個人情報は伏せ字化）'
            : format === 'pdf'
              ? 'PDF を生成できないため、Standalone HTML を出力しました'
              : 'Standalone HTML を出力しました（単体で開けます）',
        );
      }
    } catch (error) {
      console.error('[assist] report export failed', error);
      if (typeof toast === 'function') {
        toast(
          '最終報告書の出力に失敗しました：' +
            String(error && error.message ? error.message : error).slice(0, 120),
          'bad',
        );
      }
    } finally {
      AH.busy = null;
      try {
        if ((S.ui.screen || 'home') === 'wizard' && curCase() && curCase().id === c.id) uxRender();
      } catch (error) {
        // ignore
      }
    }
  }

  function ahReportSection(c, L) {
    if (!ahCompleted(c, L) || !ahCanExport(c)) return '';
    const last = c._report;
    const busy = AH.busy;
    return (
      '<div class="ahd-box" id="ahdReportBox">' +
      '<h4>📄 最終報告書</h4>' +
      '<div class="ahd-msg">STEP 3（AIで解決）と STEP 5（担当者対応で解決）のどちらでも、同じ形式で出力できます。個人情報・IP・シリアルは伏せ字化します。</div>' +
      '<div class="ahd-row" style="margin-top:8px">' +
      '<button class="u-btn pri" data-act="wReport" data-fmt="html"' +
      (busy ? ' disabled' : '') +
      '>' +
      (busy === 'html' ? '作成中…' : 'Standalone HTML') +
      '</button>' +
      '<button class="u-btn pri" data-act="wReport" data-fmt="pdf"' +
      (busy ? ' disabled' : '') +
      '>' +
      (busy === 'pdf' ? 'PDF 生成中…' : 'PDF') +
      '</button>' +
      '</div>' +
      '<div class="ahd-msg">HTML は外部ファイルを参照しない 1 ファイルです。PDF はサーバーで日本語フォントを使って生成します。</div>' +
      (last
        ? '<div class="ahd-msg">前回の出力：' +
          ahEsc(ahFmt(last.at)) +
          '（' +
          ahEsc((last.formats || []).join('・')) +
          '）／SHA-256 ' +
          ahEsc(String(last.sha256 || '').slice(0, 16)) +
          '…</div>'
        : '') +
      '</div>'
    );
  }

  function ahEnsureRemote(c) {
    const remote = c.remote;
    if (!remote) return null;
    if (
      (remote.status === 'approved' || remote.status === 'requested') &&
      remote.expiresAt &&
      Date.now() > Date.parse(remote.expiresAt)
    ) {
      remote.status = 'expired';
      remote.endedAt = ahNow();
      if (typeof auditAdd === 'function') auditAdd(S, 'system', 'remote_expired', { case: c.id });
      save();
    }
    return remote;
  }

  function ahPromptList(c, remote, isOwner) {
    const prompts = remote.prompts || [];
    if (!prompts.length) return '<div class="ahd-msg">まだ案内は送っていません。</div>';
    return prompts
      .slice()
      .reverse()
      .map((prompt) => {
        const statusLabel =
          {
            sent: '本人へ送信済み',
            done: '本人が実施',
            failed: '本人が実施できず',
            cancelled: '取り下げ',
          }[prompt.status] || prompt.status;
        return (
          '<div class="ahd-prompt ' +
          ahEsc(prompt.status) +
          '">' +
          '<div class="ahd-msg">' +
          ahEsc(ahFmt(prompt.at)) +
          '　' +
          ahEsc(prompt.by || '担当者') +
          '</div>' +
          '<div>' +
          ahEsc(prompt.text).replace(/\n/g, '<br>') +
          '</div>' +
          '<div class="ahd-msg">状態：' +
          ahEsc(statusLabel) +
          '</div>' +
          (isOwner && prompt.status === 'sent'
            ? '<div class="ahd-row"><button class="u-btn" data-act="wRemotePromptDone" data-id="' +
              ahEsc(prompt.id) +
              '">実施しました</button><button class="u-btn" data-act="wRemotePromptFailed" data-id="' +
              ahEsc(prompt.id) +
              '">できませんでした</button></div>'
            : '') +
          '</div>'
        );
      })
      .join('');
  }

  /**
   * 本人が共有した PC 情報の端末名だけを返す。
   *
   * 共有されていない PC 情報は担当者に見せないのと同じ理由で、URL にも載せない
   * (AI-HelpDesk docs/23-rsp-meshcentral-integration.md §5: 推測・漏えいで
   * 別の端末を開かせない)。空文字なら RSP 側は案件だけを開き、端末は
   * オペレータが検索して選ぶ。
   */
  function ahShareableDevice(c) {
    try {
      if (!pcVisible(c)) return '';
      const snap = c && c.pc && c.pc.state === 'done' ? c.pc.snap : null;
      const device = snap && snap.device ? String(snap.device).trim() : '';
      return device;
    } catch (error) {
      return '';
    }
  }

  /**
   * RSP の AI支援ビューを案件・端末付きで開く URL。
   *
   * 受け側は RSP の `/?helpdeskCase=<案件ID>&hostname=<端末名>`
   * (RSP docs/36-rsp-integration.md §5 Phase 3 / RSP docs/webui-navigation.md §5)。
   * caseId は Cowork の案件IDだけでなく INC-/TKT- 番号でも RSP 側が解決する。
   */
  function ahRspDeepLink(c) {
    const base = String(ahRspUrl || '').replace(/\/+$/, '');
    const params = [];
    const caseId = c && c.id ? String(c.id).trim() : '';
    if (caseId) params.push('helpdeskCase=' + encodeURIComponent(caseId));
    const device = ahShareableDevice(c);
    if (device) params.push('hostname=' + encodeURIComponent(device));
    return base + '/' + (params.length ? '?' + params.join('&') : '');
  }

  function ahRspLinks(c) {
    const rspHref = ahRspDeepLink(c);
    const device = ahShareableDevice(c);
    return (
      '<div class="ahd-row" style="margin-top:8px">' +
      '<a class="u-btn" href="' +
      ahEsc(ahMeshUrl) +
      '" target="_blank" rel="noopener noreferrer">MeshCentralを開く</a>' +
      '<a class="u-btn" href="' +
      ahEsc(rspHref) +
      '" target="_blank" rel="noopener noreferrer" title="' +
      ahEsc(
        device
          ? device + ' の端末詳細を RSP で開きます'
          : '案件を RSP で開きます（端末は RSP 側で選択）',
      ) +
      '">RSPで支援する</a>' +
      '</div>' +
      '<div class="ahd-msg">RSP は案件と端末を指定して開きます（端末が一致しない場合は RSP 側の検索から選べます）。' +
      'RSP / MeshCentral のログインは Entra ID です。</div>'
    );
  }

  function ahRemoteSection(c, L) {
    if (!L || !L.inc) return '';
    const u = ahUser();
    if (!u) return '';
    const isOwner = u.id === c.userId;
    const isHelper = isHdRole(u) && !isOwner;
    if (!isOwner && !isHelper) return '';

    const remote = ahEnsureRemote(c);
    const canOpen = L.inc.status === 'escalated' || L.inc.status === 'in_progress';
    if (!remote && !(isHelper && canOpen)) return '';

    const header = '<h4>🛟 遠隔支援（同意した範囲）</h4>';
    if (!remote) {
      return (
        '<div class="ahd-box" id="ahdRemoteBox">' +
        header +
        '<div class="ahd-msg">Aさんの同意を得て、読み取り情報の共有・案内文の送信・RSP コンソールでの操作支援を行います。' +
        '<b>画面録画は行いません。</b>端末操作のログは RSP の「コマンド実行」に残ります（対話ターミナルは残りません）。</div>' +
        '<div class="ahd-msg">対象：' +
        ahEsc(ahName(c.userId)) +
        ' さん／' +
        ahEsc(L.inc.id) +
        '</div>' +
        '<div class="ahd-row"><button class="u-btn pri" data-act="wRemoteRequest">本人に遠隔支援を依頼</button></div>' +
        ahRspLinks(c) +
        '<div class="ahd-msg">実行が必要な操作は、既存の許可リスト（SPOOLER_RESTART）と本人の Y/N・管理者承認を通します。</div>' +
        '</div>'
      );
    }

    const statusLabel =
      {
        requested: '本人の承認待ち',
        approved: '遠隔支援中（本人の同意済み）',
        denied: '本人が断りました',
        ended: '終了しました',
        expired: '期限切れ',
      }[remote.status] || remote.status;

    let body = '';
    if (remote.status === 'requested') {
      body = isOwner
        ? '<div class="ahd-msg"><b>' +
          ahEsc(remote.requestedBy || '担当者') +
          '</b> さんが、画面を見ながらの案内を求めています。</div>' +
          '<div class="ahd-note">範囲：' +
          ahEsc(remote.scope || '読み取り情報の共有と案内文の送信') +
          '</div>' +
          '<div class="ahd-msg">期限：' +
          ahEsc(ahFmt(remote.expiresAt)) +
          '</div>' +
          '<div class="ahd-row"><button class="u-btn pri" data-act="wRemoteApprove">承認する（30分）</button><button class="u-btn" data-act="wRemoteDeny">断る</button></div>'
        : '<div class="ahd-msg">本人の承認を待っています。承認されるまで、案内文は送れません。</div>' +
          '<div class="ahd-msg">依頼：' +
          ahEsc(ahFmt(remote.requestedAt)) +
          '　期限：' +
          ahEsc(ahFmt(remote.expiresAt)) +
          '</div>' +
          '<div class="ahd-row"><button class="u-btn" data-act="wRemoteEnd">依頼を取り下げる</button></div>';
    } else if (remote.status === 'approved') {
      body =
        '<div class="ahd-banner">🛟 遠隔支援中（本人の同意済み）｜期限 ' +
        ahEsc(ahFmt(remote.expiresAt)) +
        ' <button class="u-btn sm" data-act="wRemoteEnd">終了</button></div>' +
        (isHelper
          ? '<div class="ahd-msg"><b>共有された PC 基本情報</b></div>' +
            (pcVisible(c)
              ? pcCardHtml(c, true)
              : '<div class="ahd-msg">PC 基本情報は共有されていません。本人に確認してください。</div>') +
            '<div class="ahd-msg">表示は本人が共有した取得時点の情報です。最新化が必要なら、案内文で本人に再取得を依頼してください。</div>' +
            '<label class="u-fl" for="ahdRemoteIntent">AI に案内文を下書きさせる（担当者の意図）</label>' +
            '<textarea id="ahdRemoteIntent" class="u-in" rows="2" placeholder="例：印刷キューの状態を確認して、止まっているジョブを消してもらう">' +
            ahEsc(AH.intent) +
            '</textarea>' +
            '<div class="ahd-row"><button class="u-btn pri" data-act="wRemoteDraft"' +
            (AH.remoteDrafting ? ' disabled' : '') +
            '>' +
            (AH.remoteDrafting ? '下書き中…' : 'AI に下書きさせる') +
            '</button></div>' +
            (AH.draft && AH.draft.caseId === c.id
              ? '<label class="u-fl" for="ahdRemoteText">本人へ送る案内（編集できます）</label>' +
                '<div class="ahd-msg">個人情報（メール・電話・IP など）は保存前に伏せ字化します。</div>' +
                '<textarea id="ahdRemoteText" class="u-in" rows="7">' +
                ahEsc(AH.draft.text) +
                '</textarea>' +
                (AH.draft.actions && AH.draft.actions.length
                  ? '<div class="ahd-msg">推奨（実行は本人の Y/N と管理者承認が必要）：<br>' +
                    AH.draft.actions
                      .map(
                        (action) =>
                          '<span class="ahd-pill">' +
                          ahEsc(action.label) +
                          '</span> ' +
                          ahEsc(action.note || '') +
                          '<br>',
                      )
                      .join('') +
                    '</div>'
                  : '') +
                '<div class="ahd-row"><button class="u-btn pri" data-act="wRemoteSend">本人の画面に送る</button><button class="u-btn" data-act="wRemoteDiscard">下書きを消す</button></div>'
              : '')
          : '<div class="ahd-msg">担当者からの案内がここに届きます。実施したら「実施しました」を押してください。</div>') +
        '<h5>送った案内</h5>' +
        ahPromptList(c, remote, isOwner);
    } else {
      body =
        '<div class="ahd-msg">状態：' +
        ahEsc(statusLabel) +
        '（' +
        ahEsc(ahFmt(remote.endedAt || remote.approvedAt || remote.requestedAt)) +
        '）</div>' +
        (isHelper && canOpen
          ? '<div class="ahd-row"><button class="u-btn" data-act="wRemoteRequest">もう一度依頼する</button></div>'
          : '') +
        '<h5>送った案内</h5>' +
        ahPromptList(c, remote, isOwner);
    }

    return (
      '<div class="ahd-box" id="ahdRemoteBox">' +
      header +
      '<div class="ahd-msg">状態：<b>' +
      ahEsc(statusLabel) +
      '</b></div>' +
      body +
      (isHelper ? ahRspLinks(c) : '') +
      '<div class="ahd-msg">遠隔支援の依頼・承認・案内の送信は監査ログに記録します。</div>' +
      '</div>'
    );
  }

  /**
   * F-13 追記: 完了案件の承認者・承認日時を STEP7（ウィザード画面）に常設表示する。
   * これまでは同期時のトースト/チャットだけで、後から画面で確認できなかった。
   * 純粋関数（DOM 非依存）にしてテストする。
   */
  function ahApprovalNoteHtml(c) {
    if (!c || String(c.handoverStatus || '') !== 'completed') return '';
    const at = ahFormatHandoverDate(c.handoverApprovedAt);
    const by = String(c.handoverApprovedBy || '');
    if (!at && !by) return '';
    const kind = c.handoverSelfApproved ? '自己承認' : '別ID承認';
    const rows = [];
    if (by) rows.push('承認者: ' + ahEsc(by));
    if (at) rows.push('承認日時: ' + ahEsc(at) + '（' + kind + '）');
    else rows.push(kind);
    return (
      '<div class="ahd-box ahd-consent" id="ahdApprovalNote">' +
      '<h4>✅ DX推進部の対応が完了しました</h4>' +
      '<div class="ahd-msg">' +
      rows.join('<br>') +
      '</div></div>'
    );
  }

  function ahAssistHtml(c, L) {
    let html = '';
    try {
      html += ahApprovalNoteHtml(c);
    } catch (error) {
      console.error('[assist] approval note failed', error);
    }
    try {
      html += ahReportSection(c, L);
    } catch (error) {
      console.error('[assist] report section failed', error);
    }
    try {
      html += ahRemoteSection(c, L);
    } catch (error) {
      console.error('[assist] remote section failed', error);
    }
    try {
      html += ahCaseAiPanel(c);
    } catch (error) {
      console.error('[assist] case ai section failed', error);
    }
    return html;
  }

  async function ahJsonFetch(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        data && data.error && data.error.message ? data.error.message : 'HTTP ' + response.status;
      const error = new Error(message);
      error.status = response.status;
      error.code = data && data.error ? data.error.code : '';
      throw error;
    }
    return data;
  }

  function ahFetchHandoverInbox() {
    if (AH.handoverLoaded || AH.handoverLoading) return undefined;
    AH.handoverLoading = true;
    const access = window.__AIHD_STAFF_ACCESS__;
    // 担当者以外は呼ばない（判定の正本はサーバ。staff-access-bridge.js）。
    return Promise.resolve(access ? access.allowed('helpdeskActor') : true)
      .then((allowed) => (allowed ? ahJsonFetch('/api/case-handovers/inbox') : { items: [] }))
      .then((data) => {
        AH.handoverInbox = Array.isArray(data.items) ? data.items : [];
      })
      .catch((error) => {
        // DX 以外は 403。エラー表示はせず、受信箱なしとして扱う。
        if (error.status === 403) access?.deny('helpdeskActor');
        else console.warn('[assist] handover inbox failed', error);
        AH.handoverInbox = [];
      })
      .finally(() => {
        AH.handoverLoading = false;
        AH.handoverLoaded = true;
        setTimeout(ahInject, 0);
      });
  }

  /** DX 推進部グループのメンバー（宛先の選択肢）。取れなければ空配列。 */
  function ahFetchRecipients() {
    if (AH.recipientsLoaded) return Promise.resolve(AH.recipients);
    if (AH.recipientsLoading) return Promise.resolve(AH.recipients);
    AH.recipientsLoading = true;
    return ahJsonFetch('/api/case-handovers/recipients')
      .then((data) => {
        AH.recipients = Array.isArray(data.members) ? data.members : [];
        return AH.recipients;
      })
      .catch((error) => {
        console.warn('[assist] recipients failed', error);
        AH.recipients = [];
        return AH.recipients;
      })
      .finally(() => {
        AH.recipientsLoading = false;
        AH.recipientsLoaded = true;
      });
  }

  function ahCloseShareDialog() {
    const overlay = document.getElementById('ahdShareOverlay');
    if (overlay) overlay.remove();
    AH.shareOpen = false;
  }

  /**
   * 引継ぎの宛先は「DX 推進部グループ」で固定。個人を指名するときは
   * 名簿から選択式で選ぶ（自由入力にしない）。
   */
  function ahOpenShareDialog() {
    if (AH.shareOpen) return Promise.resolve();
    const c = ahCurrentCase();
    if (!c || c.closed === 'ai' || c._handoverId) return Promise.resolve();
    AH.shareOpen = true;
    return ahFetchRecipients().then((members) => {
      const overlay = document.createElement('div');
      overlay.id = 'ahdShareOverlay';
      overlay.className = 'ahd-overlay';
      overlay.innerHTML =
        '<div class="ahd-modal" role="dialog" aria-modal="true" aria-labelledby="ahdShareTitle">' +
        '<h4 id="ahdShareTitle">DX 推進部へ引き継ぐ</h4>' +
        '<div class="ahd-msg">宛先は <b>DX 推進部グループ</b> です。特定の担当者に渡す場合だけ、名簿から選んでください。</div>' +
        '<label class="ahd-f">宛先<select id="ahdShareTo" class="u-in">' +
        '<option value="">グループ全員（指名なし）</option>' +
        members
          .map(
            (member) =>
              '<option value="' +
              ahEsc(member.employeeNo) +
              '">' +
              ahEsc(member.label || member.name) +
              '</option>',
          )
          .join('') +
        '</select></label>' +
        (members.length
          ? ''
          : '<div class="ahd-note">名簿を取得できないため、グループ全員宛だけ選べます。</div>') +
        '<div class="ahd-row" style="justify-content:flex-end;margin-top:10px">' +
        '<button class="u-btn" data-ahd="share-cancel">やめる</button>' +
        '<button class="u-btn pri" data-ahd="share-ok">この宛先で引き継ぐ</button>' +
        '</div></div>';
      document.body.appendChild(overlay);
      const select = document.getElementById('ahdShareTo');
      overlay.addEventListener('click', (event) => {
        const act =
          event.target && event.target.getAttribute ? event.target.getAttribute('data-ahd') : null;
        if (act === 'share-cancel') {
          ahCloseShareDialog();
          return;
        }
        if (act === 'share-ok') {
          const recipientNo = select && select.value ? select.value : '';
          ahCloseShareDialog();
          void ahShareCase(recipientNo);
        }
      });
      if (select) select.focus();
    });
  }

  async function ahShareCase(recipientNo) {
    let attempts = 0;
    const attempt = async () => {
      const c = ahCurrentCase();
      if (!c || c.closed === 'ai') return;
      const L = link(c);
      if (!L || !L.tkt) {
        if (attempts++ < 8) {
          setTimeout(() => void attempt(), 400);
          return;
        }
        return;
      }
      if (c._handoverId) return;
      try {
        const payload = { caseId: c.id };
        // STEP4 直後の共有でも通知メールの件名が空にならないよう、画面の件名も送る。
        // 件名が無い場合は従来どおり caseId だけで共有する（サーバ側で補完される）。
        if (c.subject) payload.subject = c.subject;
        if (recipientNo) payload.recipientNo = recipientNo;
        const data = await ahJsonFetch('/api/case-handovers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        c._handoverId = data.handover ? data.handover.id : null;
        save();
        if (typeof toast === 'function') {
          const to =
            data.handover && data.handover.recipientName
              ? data.handover.recipientName + ' さん'
              : 'DX 推進部グループ';
          toast(to + 'へ引き継ぎました（受信箱に届きます）');
        }
      } catch (error) {
        console.warn('[assist] handover share failed', error);
        if (typeof toast === 'function') {
          toast(
            '引継ぎの共有に失敗しました：' + String(error.message || error).slice(0, 100),
            'bad',
          );
        }
      }
    };
    await attempt();
  }

  async function ahClaimHandover(id, retry = 0) {
    try {
      await ahJsonFetch('/api/case-handovers/' + encodeURIComponent(id) + '/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (typeof toast === 'function') toast('引継ぎ案件を引き受けました。画面を開きます');
      setTimeout(() => location.reload(), 400);
    } catch (error) {
      if (error.code === 'STATE_NOT_READY' && retry < 5) {
        if (typeof toast === 'function') toast('画面の保存を待って、もう一度お試しください');
        setTimeout(() => void ahClaimHandover(id, retry + 1), 1500);
        return;
      }
      if (typeof toast === 'function') {
        toast('引き受けに失敗しました：' + String(error.message || error).slice(0, 120), 'bad');
      }
    }
  }

  /**
   * 承認しようとしているナレッジ下書きに対応する、共有済みの案件。
   * 下書きが別案件のものなら null（別の引継ぎを誤って承認しない）。
   */
  function ahSharedCaseForDraft(draftId) {
    const cases = (S.cases || []).filter((item) => item.handoverId);
    if (!cases.length) return null;
    const draft = draftId ? ahDraftInfo(draftId) : null;
    if (draft) {
      const linked = cases.find((item) => {
        try {
          const L = link(item);
          return L && L.dr && L.dr.id === draft.id;
        } catch (error) {
          return false;
        }
      });
      if (linked) return linked;
      const byTicket = cases.find((item) => {
        try {
          const L = link(item);
          return L && L.tkt && L.tkt.id === draft.ticketId;
        } catch (error) {
          return false;
        }
      });
      if (byTicket) return byTicket;
      // どの共有案件の下書きでもない → サーバー承認の対象にしない。
      return null;
    }
    const current = ahCurrentCase();
    return current && current.handoverId ? current : null;
  }

  /**
   * 下書き情報を取る。
   * ヘルプデスク側の state / drById は IIFE に閉じているため、公開 API
   * `window.HD.draftInfo()` を使う（使えない画面ではグローバル関数へフォールバック）。
   */
  function ahDraftInfo(draftId) {
    try {
      if (window.HD && typeof window.HD.draftInfo === 'function') {
        return window.HD.draftInfo(draftId) || null;
      }
    } catch (error) {
      // 公開 API が使えない環境では下のフォールバックへ。
    }
    try {
      return typeof drById === 'function' ? drById(draftId) || null : null;
    } catch (error) {
      return null;
    }
  }

  /** 現在の操作者名（ヘルプデスク側 state.actor は window.HD.actor() で公開されている）。 */
  function ahActorName() {
    try {
      if (window.HD && typeof window.HD.actor === 'function') {
        const name = window.HD.actor();
        if (name) return String(name);
      }
    } catch (error) {
      // 下のフォールバックへ。
    }
    try {
      return typeof state !== 'undefined' && state ? String(state.actor || '') : '';
    } catch (error) {
      return '';
    }
  }

  /**
   * 承認画面のチェックリスト（#ck0〜#ck3）の状態。
   * 画面上に4件そろっていない場合は null を返す（検証不能として扱う）。
   */
  function ahApproveChecklist() {
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function')
      return null;
    const boxes = [];
    for (let index = 0; index < 4; index += 1) {
      const input = document.getElementById('ck' + index);
      if (!input) return null;
      boxes.push(input);
    }
    return boxes;
  }

  /**
   * 承認前のクライアント検証。
   * - 内部状態は window.HD（公開 API）と DOM だけから判定する。
   * - 判定できない項目・状態はブロックしない（従来動作へフォールバックし、
   *   「見つかりません」のような誤った中断を出さない）。
   */
  function ahClientApproveBlockReason(draftId) {
    const draft = ahDraftInfo(draftId);
    if (!draft) return null;
    const actor = ahActorName();
    if (actor && draft.applicant && actor === draft.applicant) {
      return '申請者本人は承認できません（申請した人と承認する人を分けるため）';
    }
    const boxes = ahApproveChecklist();
    if (boxes && boxes.some((input) => !input.checked)) {
      return 'チェックリストをすべて確認してください';
    }
    return null;
  }

  /**
   * F-06: 画面のナレッジ下書き・承認をサーバーへ永続化する。
   *
   * 従来はブラウザの state だけを更新していたため knowledge テーブルが空の
   * ままだった。画面の下書き ID を clientRef にして冪等に同期する。
   */
  function ahKnowledgeSyncPayload(draft, status, extra) {
    const payload = {
      clientRef: 'ui-' + String(draft.id),
      status: status,
      title: String(draft.title || '').slice(0, 160) || '（無題）',
      symptom: String(draft.symptom || ''),
      cause: String(draft.cause || ''),
      steps: String(draft.steps || ''),
      keywords: [],
    };
    if (extra && extra.comment) payload.comment = String(extra.comment).slice(0, 2000);
    if (extra && extra.checklist) payload.checklist = extra.checklist;
    return payload;
  }

  function ahSyncKnowledge(draft, status, extra) {
    return ahJsonFetch('/api/knowledge/ui-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ahKnowledgeSyncPayload(draft, status, extra)),
    });
  }

  const AH_KB_NOT_FOR_AI =
    '作成者本人の承認のため、AI の根拠には使いません（別の承認者の承認が必要です）';

  /**
   * 原本の完了モーダルは「次回から AI の根拠に使う」と固定で表示する。
   * サーバーが AI の根拠にしないと判定した場合だけ、文言を実際の結果に置き換える（DOM は変えない）。
   */
  function ahCorrectReflectModal(reason) {
    if (!document || typeof document.querySelector !== 'function') return;
    const step = document.querySelector('#rs4 span:last-child');
    if (step) step.textContent = 'AI の根拠には使いません';
    const note = document.querySelector('#rsdone .note');
    if (note) note.textContent = reason;
  }

  /** 引継ぎの承認後に、KB 公開を別の判定としてサーバーへ保存する。失敗しても引継ぎの承認は戻さない。 */
  function ahPublishKnowledgeAfterHandover(full, checklist, comment) {
    if (!full) return Promise.resolve({ published: false, reason: '下書きを取得できません' });
    return ahSyncKnowledge(full, 'approved', { checklist: checklist, comment: comment })
      .then((data) => ({ published: true, aiUsable: Boolean(data && data.aiUsable) }))
      .catch((error) => ({ published: false, reason: ahUiSyncErrorLabel(error) }));
  }

  /** 引継ぎの承認と KB 公開の結果を、混同しない文言にする（純粋関数）。 */
  function ahHandoverApprovalNotice(approved, kb) {
    const source = approved || {};
    const head = source.selfApproved
      ? '自分の対応した案件を自己承認しました（DX 推進部の別の担当者が承認することが望ましい）。'
      : '引継ぎの完了を承認しました（承認者: ' + String(source.approvedByName || '') + '）。';
    if (kb && kb.published && kb.aiUsable) {
      return {
        text: head + 'ナレッジも公開し、次の相談から AI の根拠に使います。',
        tone: source.selfApproved ? 'bad' : '',
      };
    }
    if (kb && kb.published) {
      return { text: head + 'ナレッジは公開しましたが、' + AH_KB_NOT_FOR_AI + '。', tone: 'bad' };
    }
    return {
      text:
        head +
        'ナレッジは公開されていません（AI の根拠になりません）。サーバ下書きから承認してください：' +
        String((kb && kb.reason) || '不明なエラー'),
      tone: 'bad',
    };
  }

  // ---------------------------------------------------------------------
  // 画面内（state）の KB はブラウザのデータで、DB で承認されたとは限らない。
  // サーバーの判定（GET /api/knowledge/approved-refs）に一致するものだけ承認済みと表示する。
  // 原本 HTML は変えず、window.HD の戻り値と配信時の差し替え（prototype.ts）で表示を変える。
  // ---------------------------------------------------------------------
  const AH_HELPDESK_STATE_KEY = 'mirai-wizard-v31-helpdesk';
  const AH_KB_LOCAL_OWNER = '画面内の資料（DB で未承認）';

  /** state の KB が DB で承認済みか。下書き → clientRef → 題名の順に照合する（純粋関数）。 */
  function ahKbIsDbApproved(kb, drafts, refs) {
    if (!kb || !refs || !Array.isArray(refs.items) || !Array.isArray(drafts)) return false;
    const draft = drafts.find((item) => item && item.kbId === kb.id);
    if (!draft) return false;
    // 下書き番号はブラウザごとの連番で重なるので、題名まで一致したものだけを同じ KB と見なす。
    const base = 'ui-' + String(draft.id);
    return refs.items.some(
      (item) =>
        (item.clientRef === base || String(item.clientRef).startsWith(base + '~')) &&
        item.title === kb.title,
    );
  }

  /** HD.kb() の戻り値から、DB で未承認のものの「承認済み」表示を外す（純粋関数）。 */
  function ahLabelHdKb(items, drafts, refs) {
    return (Array.isArray(items) ? items : []).map((item) =>
      ahKbIsDbApproved(item, drafts, refs)
        ? item
        : Object.assign({}, item, { src: 'local', owner: AH_KB_LOCAL_OWNER }),
    );
  }

  let ahDraftCacheRaw = null;
  let ahDraftCache = [];
  function ahLocalDrafts() {
    try {
      const raw = localStorage.getItem(AH_HELPDESK_STATE_KEY);
      if (raw !== ahDraftCacheRaw) {
        ahDraftCacheRaw = raw;
        const parsed = raw ? JSON.parse(raw) : null;
        ahDraftCache = parsed && Array.isArray(parsed.drafts) ? parsed.drafts : [];
      }
    } catch (error) {
      ahDraftCache = [];
    }
    return ahDraftCache;
  }

  function ahRefreshKbApprovals() {
    return ahJsonFetch('/api/knowledge/approved-refs')
      .then((data) => {
        AH.kbRefs = data;
      })
      .catch(() => {
        // 判定できない間は承認済みと表示しない。
        AH.kbRefs = null;
      });
  }

  function ahInstallKbLabels() {
    // 配信時の差し替え（prototype.ts の patchKbLabels）が呼ぶ。
    window.__AIHD_KB_APPROVAL__ = (kb) =>
      ahKbIsDbApproved(kb, ahLocalDrafts(), AH.kbRefs)
        ? '承認：' + String((kb && kb.approvedBy) || '')
        : 'DB 未承認';
    const hd = window.HD;
    if (hd && typeof hd.kb === 'function') {
      const originalKb = hd.kb.bind(hd);
      hd.kb = () => ahLabelHdKb(originalKb(), ahLocalDrafts(), AH.kbRefs);
    }
    if (hd && typeof hd.stats === 'function') {
      const originalStats = hd.stats.bind(hd);
      // 画面の「承認済みナレッジ」の件数は、AI の根拠に使える DB の件数にする。
      hd.stats = () =>
        Object.assign({}, originalStats(), { kb: AH.kbRefs ? Number(AH.kbRefs.count) || 0 : 0 });
    }
    void ahRefreshKbApprovals();
    setInterval(() => void ahRefreshKbApprovals(), 60_000);
  }

  /** 承認画面のチェックリスト4件の状態（取得できなければ null）。 */
  function ahApproveChecklistValues() {
    const boxes = ahApproveChecklist();
    if (!boxes || boxes.length < 4) return null;
    return {
      reproducible: Boolean(boxes[0] && boxes[0].checked),
      noSecrets: Boolean(boxes[1] && boxes[1].checked),
      noBlame: Boolean(boxes[2] && boxes[2].checked),
      scopeClear: Boolean(boxes[3] && boxes[3].checked),
    };
  }

  /** 承認画面のコメント（差戻し理由にも使う）。 */
  function ahApproveComment() {
    const input = document.getElementById('ap_c');
    return input ? String(input.value || '').trim() : '';
  }

  // ---------------------------------------------------------------------
  // F-06 不足分: 承認者（別ID）向けのサーバ下書き一覧
  //
  // ローカルの下書きはブラウザの state にしか無いため、別 ID の承認者には見えない。
  // ⑥ 承認者の確認を表示したときに GET /api/knowledge/pending を取得し、
  // 既存の POST /api/knowledge/ui-sync（UiSyncSchema）で承認/却下する。
  // サーバ未実装・障害時は「取得できませんでした」表示だけでローカル画面は通常動作。
  // ---------------------------------------------------------------------
  const AH_PENDING_CHECKS = [
    { key: 'reproducible', label: '技術的に正確で、第三者が再現できる手順になっている' },
    { key: 'noSecrets', label: '個人情報・認証情報・IPアドレス等の機密情報が含まれていない' },
    { key: 'noBlame', label: '特定の個人を評価・非難する記述がない（事実と手順のみ）' },
    { key: 'scopeClear', label: '適用範囲（対象拠点・端末・バージョン）が明確である' },
  ];

  /** ui-sync のエラーコードをトースト用ラベルにする。 */
  function ahUiSyncErrorLabel(error) {
    if (!error) return '不明なエラー';
    if (error.code) return String(error.code);
    if (error.status) return 'HTTP ' + String(error.status);
    return String(error.message || error).slice(0, 120);
  }

  /** サーバ下書きの承認ペイロード（UiSyncSchema に一致させる）。 */
  function ahPendingApprovePayload(item, checklist, comment) {
    const source = item || {};
    return {
      clientRef: String(source.clientRef || 'ui-' + String(source.id || '')),
      status: 'approved',
      title: String(source.title || '').slice(0, 160) || '（無題）',
      symptom: String(source.symptom || ''),
      cause: String(source.cause || ''),
      steps: String(source.steps || ''),
      keywords: Array.isArray(source.keywords)
        ? source.keywords.map((keyword) => String(keyword)).slice(0, 12)
        : [],
      checklist: {
        reproducible: Boolean(checklist && checklist.reproducible),
        noSecrets: Boolean(checklist && checklist.noSecrets),
        noBlame: Boolean(checklist && checklist.noBlame),
        scopeClear: Boolean(checklist && checklist.scopeClear),
      },
      comment: String(comment || '').slice(0, 2000),
    };
  }

  /** サーバ下書きの却下ペイロード（理由必須・checklist は送らない）。 */
  function ahPendingRejectPayload(item, reason) {
    const payload = ahPendingApprovePayload(item, null, reason);
    payload.status = 'rejected';
    delete payload.checklist;
    return payload;
  }

  /** 承認者ビューに差し込む「サーバ下書き」セクションの HTML（純粋関数・テスト対象）。 */
  function ahPendingSectionHtml(items, errorCode) {
    const list = Array.isArray(items) ? items : [];
    const head =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
      '<b>サーバ下書き（承認待ち）</b>' +
      '<button class="btn ghost sm" data-ahd="pd-refresh">再読込</button>' +
      '</div><div class="hint">ローカルの下書きとは別に、サーバに保存された下書きです。承認するとサーバ側のナレッジになります。</div>';
    const errorNote = errorCode
      ? '<div class="note n-warn" style="margin-top:6px">サーバ下書きを取得できませんでした（' +
        ahEsc(errorCode) +
        '）。ローカルの下書きのみ表示しています。</div>'
      : '';
    if (list.length === 0) {
      return (
        head +
        errorNote +
        '<div class="empty" style="margin-top:6px">サーバの承認待ちはありません</div>'
      );
    }
    const rows = list
      .map((item) => {
        const id = String(item.id || '');
        const status = String(item.status || '');
        const approved = status === 'approved' || item._localState === 'approved';
        const rejected = status === 'rejected' || item._localState === 'rejected';
        const kbNo = String(item.kbNo || '');
        const checks =
          approved || rejected
            ? ''
            : AH_PENDING_CHECKS.map(
                (check) =>
                  '<label class="chk"><input type="checkbox" data-pd-check="' +
                  ahEsc(id) +
                  '" data-pd-key="' +
                  check.key +
                  '">' +
                  ahEsc(check.label) +
                  '</label>',
              ).join('');
        const actions = approved
          ? '<span class="badge b-ok">承認済み' +
            (kbNo ? '（' + ahEsc(kbNo) + '）' : '') +
            '</span>'
          : rejected
            ? '<span class="badge b-bad">却下済み</span>'
            : '<div class="btns"><button class="btn ok sm" data-ahd="pd-approve" data-id="' +
              ahEsc(id) +
              '" disabled>承認</button><button class="btn bad sm" data-ahd="pd-reject" data-id="' +
              ahEsc(id) +
              '">却下</button></div>';
        return (
          '<li style="border-top:1px solid var(--u-line,#d9e2ec);padding:8px 0" data-pd-item="' +
          ahEsc(id) +
          '">' +
          '<div><span class="mono">' +
          ahEsc(kbNo || id) +
          '</span> <b>' +
          ahEsc(item.title || '(件名なし)') +
          '</b></div>' +
          '<div class="hint">作成者 ' +
          ahEsc(item.authorEmail || '-') +
          '／状態 ' +
          ahEsc(status || '-') +
          (item.createdAt ? '／作成 ' + ahEsc(String(item.createdAt)) : '') +
          '</div>' +
          checks +
          actions +
          '</li>'
        );
      })
      .join('');
    return (
      head + errorNote + '<ul style="list-style:none;margin:8px 0 0;padding:0">' + rows + '</ul>'
    );
  }

  function ahIsApproveView() {
    try {
      const hd = document.getElementById('hd');
      if (hd && hd.classList.contains('hide')) return false;
      const main = document.getElementById('hdMain');
      if (!main) return false;
      const heading = main.querySelector('h1');
      return Boolean(heading && /承認者の確認/.test(heading.textContent || ''));
    } catch (error) {
      return false;
    }
  }

  function ahPendingSignature() {
    const items = Array.isArray(AH.pending) ? AH.pending : [];
    return (
      (AH.pendingError || '') +
      '|' +
      items.map((item) => [item.id, item.status, item.kbNo, item._localState].join(':')).join(',')
    );
  }

  function ahSyncPendingSection() {
    try {
      const main = document.getElementById('hdMain');
      if (!main) return;
      const existing = document.getElementById('ahServerPending');
      if (!ahIsApproveView()) {
        if (existing) existing.remove();
        return;
      }
      if (!AH.pendingLoaded) {
        void ahRefreshPending(false);
        return;
      }
      const signature = ahPendingSignature();
      if (existing && existing.getAttribute('data-sig') === signature) return;
      if (existing) existing.remove();
      const box = document.createElement('div');
      box.id = 'ahServerPending';
      box.className = 'card';
      box.style.marginTop = '12px';
      box.setAttribute('data-sig', signature);
      box.innerHTML = ahPendingSectionHtml(AH.pending, AH.pendingError);
      main.appendChild(box);
    } catch (error) {
      console.warn('[assist] pending draft section failed', error);
    }
  }

  async function ahRefreshPending(force) {
    const now = Date.now();
    if (!force && AH.pendingLoaded && now - AH.pendingLoadedAt < 10_000) {
      ahSyncPendingSection();
      return;
    }
    try {
      const data = await ahJsonFetch('/api/knowledge/pending');
      AH.pending = Array.isArray(data && data.items)
        ? data.items.map((item) => Object.assign({}, item))
        : [];
      AH.pendingError = '';
    } catch (error) {
      AH.pending = Array.isArray(AH.pending) ? AH.pending : [];
      AH.pendingError = ahUiSyncErrorLabel(error);
      console.warn('[assist] pending drafts failed', error);
    } finally {
      AH.pendingLoaded = true;
      AH.pendingLoadedAt = now;
      ahSyncPendingSection();
    }
  }

  function ahFindPending(id) {
    const target = String(id || '');
    return (AH.pending || []).find((item) => String(item.id) === target) || null;
  }

  async function ahApprovePending(item) {
    if (!item) return;
    const boxes = Array.from(document.querySelectorAll('[data-pd-check]')).filter(
      (box) => box.getAttribute('data-pd-check') === String(item.id),
    );
    const checklist = {};
    for (const check of AH_PENDING_CHECKS) {
      const box = boxes.find((candidate) => candidate.getAttribute('data-pd-key') === check.key);
      checklist[check.key] = Boolean(box && box.checked);
    }
    if (!AH_PENDING_CHECKS.every((check) => checklist[check.key])) {
      if (typeof toast === 'function') toast('チェックリストをすべて確認してください', 'bad');
      return;
    }
    if (AH.pendingBusy) return;
    AH.pendingBusy = true;
    try {
      const data = await ahJsonFetch('/api/knowledge/ui-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ahPendingApprovePayload(item, checklist, '')),
      });
      const kbNo = data && data.knowledge ? String(data.knowledge.kbNo || '') : '';
      item.status = 'approved';
      item._localState = 'approved';
      if (kbNo) item.kbNo = kbNo;
      if (typeof toast === 'function') {
        if (data && data.aiUsable === false) {
          toast('承認しましたが、' + AH_KB_NOT_FOR_AI, 'bad');
        } else {
          toast('サーバのナレッジを承認しました' + (kbNo ? '（' + kbNo + '）' : ''), 'ok');
        }
      }
      // 承認済みは pending 一覧から消えるため、サーバから取り直す。
      await ahRefreshPending(true);
    } catch (error) {
      if (typeof toast === 'function') {
        toast('サーバ承認に失敗しました：' + ahUiSyncErrorLabel(error), 'bad');
      }
    } finally {
      AH.pendingBusy = false;
    }
  }

  async function ahRejectPending(item) {
    if (!item) return;
    const reason =
      typeof window.prompt === 'function'
        ? String(window.prompt('却下の理由を入力してください（必須）') || '').trim()
        : '';
    if (!reason) {
      if (typeof toast === 'function') toast('却下の理由を入力してください', 'bad');
      return;
    }
    if (AH.pendingBusy) return;
    AH.pendingBusy = true;
    try {
      await ahJsonFetch('/api/knowledge/ui-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ahPendingRejectPayload(item, reason)),
      });
      item.status = 'rejected';
      item._localState = 'rejected';
      if (typeof toast === 'function') toast('サーバ下書きを却下しました', 'ok');
      await ahRefreshPending(true);
    } catch (error) {
      if (typeof toast === 'function') {
        toast('サーバ却下に失敗しました：' + ahUiSyncErrorLabel(error), 'bad');
      }
    } finally {
      AH.pendingBusy = false;
    }
  }

  function ahHandlePendingClick(event) {
    const target = event && event.target;
    const trigger = target && target.closest ? target.closest('[data-ahd]') : null;
    if (!trigger) return;
    const action = trigger.getAttribute('data-ahd');
    const id = trigger.getAttribute('data-id');
    if (action === 'pd-refresh') {
      void ahRefreshPending(true);
    } else if (action === 'pd-approve') {
      void ahApprovePending(ahFindPending(id));
    } else if (action === 'pd-reject') {
      void ahRejectPending(ahFindPending(id));
    }
  }

  function ahHandlePendingChange(event) {
    const target = event && event.target;
    if (!target || !target.getAttribute) return;
    const id = target.getAttribute('data-pd-check');
    if (!id) return;
    const boxes = Array.from(document.querySelectorAll('[data-pd-check]')).filter(
      (box) => box.getAttribute('data-pd-check') === id,
    );
    const button = Array.from(document.querySelectorAll('[data-ahd="pd-approve"]')).find(
      (candidate) => candidate.getAttribute('data-id') === id,
    );
    if (button) {
      button.disabled = !(boxes.length === 4 && boxes.every((box) => box.checked));
    }
  }

  /** 引継ぎ案件ではない下書きを、サーバーへ承認として保存してから画面を更新する。 */
  function ahApproveLocalKnowledge(draftId, originalApprove, context, args) {
    const full =
      window.HD && typeof window.HD.draftForSync === 'function'
        ? window.HD.draftForSync(draftId)
        : null;
    if (!full) return originalApprove.apply(context, args);
    const blocked = ahClientApproveBlockReason(draftId);
    if (blocked) {
      if (typeof toast === 'function') toast(blocked, 'bad');
      return undefined;
    }
    return ahSyncKnowledge(full, 'approved', {
      checklist: ahApproveChecklistValues(),
      comment: ahApproveComment(),
    })
      .then((data) => {
        const result = originalApprove.apply(context, args);
        if (data && data.aiUsable === false) {
          ahCorrectReflectModal(AH_KB_NOT_FOR_AI + '。');
          if (typeof toast === 'function') toast(AH_KB_NOT_FOR_AI, 'bad');
        }
        return result;
      })
      .catch((error) => {
        console.error('[assist] knowledge sync (approve) failed', error);
        if (typeof toast === 'function') {
          toast(
            'ナレッジをサーバーへ保存できなかったため、承認は行っていません：' +
              String(error.message || error).slice(0, 120),
            'bad',
          );
        }
        return undefined;
      });
  }

  /**
   * サーバー承認が成立した後にローカル承認が失敗した場合の補償（F-12）。
   * 引継ぎを resolved に戻して再承認できる状態にする。戻せない場合は明示する。
   */
  function ahRecoverHandoverAfterLocalApproveFailure(handoverId, localError) {
    if (localError) console.error('[assist] local approve failed', localError);
    return ahJsonFetch('/api/case-handovers/' + encodeURIComponent(handoverId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved', note: '画面側の承認失敗による補償（F-12）' }),
    })
      .then(() => {
        if (typeof toast === 'function') {
          toast(
            'サーバーの承認は成立しましたが、画面の承認に失敗したため、引継ぎを「対応中」に戻しました。チェックリストを確認して、もう一度承認してください。',
            'bad',
          );
        }
      })
      .catch((error) => {
        console.error('[assist] handover recovery failed', error);
        if (typeof toast === 'function') {
          toast(
            'サーバーの承認は完了しましたが、画面の承認に失敗し、状態も自動で戻せませんでした（' +
              String(error.message || error).slice(0, 120) +
              '）。引継ぎ「' +
              handoverId +
              '」を status=resolved に戻す必要があります。管理者に連絡してください。',
            'bad',
          );
        }
      });
  }

  /**
   * F-13: 依頼者側の画面にサーバの引継ぎ状態を反映する。
   *
   * 案件（prototype_states の cowork 状態）はブラウザ側にあり、サーバの
   * case_handovers.status と二重管理になっている。ここでは起動時・再表示時・
   * 定期（45秒）に GET /api/case-handovers/{id} を取得し、
   *   claimed / resolved → STEP5（担当者の対応＝対応中）
   *   completed          → STEP7（完了）
   * として表示する。取得できない場合（403/404/通信断）は従来表示のままにする。
   */
  function ahHandoverIdOf(c) {
    if (!c) return '';
    const id = c.handoverId || c._handoverId;
    return typeof id === 'string' ? id : '';
  }

  function ahApplyHandoverStatus(c, handover) {
    if (!c || !handover) return false;
    const status = String(handover.status || '');
    if (!['claimed', 'resolved', 'completed'].includes(status)) return false;
    const previous = String(c.handoverStatus || '');
    c.handoverStatus = status;
    c.handoverSyncedAt = new Date().toISOString();
    if (handover.claimedByName) c.handoverClaimedBy = String(handover.claimedByName);
    if (handover.approvedAt) c.handoverApprovedAt = String(handover.approvedAt);
    if (handover.approvedBy) c.handoverApprovedBy = String(handover.approvedBy);
    if (typeof handover.selfApproved === 'boolean') c.handoverSelfApproved = handover.selfApproved;
    const step = Number(c.step || 0);
    if (status === 'completed') {
      if (step < 7) c.step = 7;
    } else if (step < 5) {
      c.step = 5;
    }
    return previous !== status;
  }

  /**
   * 表示用 link() にサーバ状態を重ねる。
   * HTML は正本のため変更せず、`L.inc` を解決済み／対応中として扱うことで
   * stageLabel / reach / ボード件数が既存ロジックのまま「対応中」「完了」になる。
   */
  function ahLinkWithHandover(c, L) {
    const status = String((c && c.handoverStatus) || '');
    if (!status || !['claimed', 'resolved', 'completed'].includes(status)) return L;
    const base = L && L.inc ? L.inc : null;
    const assignee = String((c && c.handoverClaimedBy) || '');
    const inc = Object.assign(
      { id: 'SYNCED-' + String((c && c.id) || ''), status: 'in_progress', assignee },
      base || {},
    );
    if (status === 'completed') {
      inc.status = 'resolved';
      inc.draftId = '';
      inc.kbId = '';
      if (!inc.resolution) {
        inc.resolution = {
          cause: 'DX推進部の担当者が対応しました。',
          steps: [],
          by: assignee,
          minutes: 0,
        };
      }
    } else {
      inc.status = 'in_progress';
    }
    return Object.assign({}, L, { inc });
  }

  function ahFormatHandoverDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    try {
      return date.toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });
    } catch (error) {
      return date.toISOString();
    }
  }

  /** 状態が変わったときだけ、トースト・監査・チャットに通知する（F-13）。 */
  function ahAnnounceHandoverChange(c, handover, previousStatus) {
    const status = String(handover.status || '');
    const approvedAt = ahFormatHandoverDate(handover.approvedAt);
    const selfApproved = Boolean(handover.selfApproved);
    try {
      if (typeof auditAdd === 'function') {
        auditAdd(S, 'system', 'hd_synced', {
          case: c.id,
          handover: ahHandoverIdOf(c),
          status,
          ...(approvedAt ? { approvedAt, selfApproved } : {}),
        });
      }
    } catch (error) {
      // 監査ログが無い画面でも状態反映は続ける。
    }
    if (status === 'completed') {
      const detail = approvedAt
        ? `承認: ${approvedAt}${selfApproved ? '（自己承認）' : ''}`
        : selfApproved
          ? '自己承認'
          : '';
      if (typeof toast === 'function') {
        toast(`DX推進部の対応が完了しました${detail ? `（${detail}）` : ''}`, 'ok');
      }
      try {
        const chat =
          Array.isArray(S.chats) && c.chatId ? S.chats.find((item) => item.id === c.chatId) : null;
        const marker = 'sys-handover-complete-' + ahHandoverIdOf(c);
        if (chat && Array.isArray(chat.messages) && !chat.messages.some((m) => m.id === marker)) {
          chat.messages.push({
            id: marker,
            kind: 'ai',
            model: 'AIヘルプデスク連携',
            html: `<p>DX推進部の対応が完了しました。</p>${
              detail ? `<p class="small">${detail}</p>` : ''
            }<p class="small muted">内容はSTEP7の完了画面で確認できます。</p>`,
            at: new Date().toISOString(),
          });
        }
      } catch (error) {
        // チャットが無い画面でも状態反映は続ける。
      }
    } else if (status === 'claimed' && previousStatus !== 'claimed') {
      if (typeof toast === 'function') toast('DX推進部の担当者が対応を開始しました', 'ok');
    } else if (status === 'resolved' && previousStatus !== 'resolved') {
      if (typeof toast === 'function') toast('DX推進部が対応を完了しました（承認待ち）', 'ok');
    }
  }

  async function ahSyncHandoverStatuses() {
    ahInstallHandoverLinkOverlay();
    if (AH.handoverStatusSyncing) return;
    if (typeof S === 'undefined' || !S || !Array.isArray(S.cases)) return;
    AH.handoverStatusSyncing = true;
    AH.handoverStatusSyncedAt = Date.now();
    let changed = false;
    try {
      for (const c of S.cases.slice()) {
        const handoverId = ahHandoverIdOf(c);
        if (!handoverId) continue;
        let data = null;
        try {
          data = await ahJsonFetch(`/api/case-handovers/${encodeURIComponent(handoverId)}`);
        } catch (error) {
          // 403（他人の案件）・404・通信断は静かにスキップし、画面は従来表示のままにする。
          continue;
        }
        const handover = data && data.handover ? data.handover : null;
        if (!handover) continue;
        const previous = String(c.handoverStatus || '');
        if (ahApplyHandoverStatus(c, handover)) {
          changed = true;
          ahAnnounceHandoverChange(c, handover, previous);
        }
      }
    } catch (error) {
      console.warn('[assist] handover status sync failed', error);
    } finally {
      AH.handoverStatusSyncing = false;
    }
    if (changed) {
      try {
        save();
      } catch (error) {
        // 保存できなくても画面表示は更新する。
      }
      try {
        if (typeof uxLater === 'function') uxLater();
      } catch (error) {
        // 画面が無い環境では何もしない。
      }
    }
  }

  /** link() を1回だけラップし、サーバ状態を重ねて表示する（F-13）。 */
  function ahInstallHandoverLinkOverlay() {
    try {
      const original = window.link;
      if (typeof original !== 'function' || original.__ahHandoverOverlay) return;
      const wrapped = function (c) {
        const L = original.apply(this, arguments);
        try {
          return ahLinkWithHandover(c, L);
        } catch (error) {
          return L;
        }
      };
      wrapped.__ahHandoverOverlay = true;
      window.link = wrapped;
    } catch (error) {
      console.warn('[assist] handover link overlay failed', error);
    }
  }

  async function ahSyncHandoverStatus(status, draftId) {
    const current = ahCurrentCase();
    const candidates = (S.cases || []).filter((item) => item.handoverId);
    let target = current && current.handoverId ? current : null;
    if (!target && draftId) {
      target =
        candidates.find((item) => {
          try {
            return link(item).dr && link(item).dr.id === draftId;
          } catch (error) {
            return false;
          }
        }) || null;
    }
    // 対象が特定できないときに「他の案件の引継ぎ」を更新しない（取り違え防止）。
    // 以前は candidates[0] へフォールバックしていたため、古い案件の handoverId を
    // PATCH して 404 になる事例があった（2026-10-25 実測）。
    if (!target || !target.handoverId) return;
    try {
      await ahJsonFetch('/api/case-handovers/' + encodeURIComponent(target.handoverId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    } catch (error) {
      console.warn('[assist] handover status sync failed', error);
    }
  }

  function ahCaseAiPanel(c) {
    if (!c || !c.shared || c.closed === 'ai') return '';
    let helper = false;
    try {
      helper = isHdRole(me());
    } catch (error) {
      helper = false;
    }
    if (!helper) return '';
    return (
      '<div class="ahd-box" id="ahdCaseAiBox">' +
      '<h4>🤖 AI に追加で聞く（DX 推進部）</h4>' +
      '<div class="ahd-msg">A さんが共有した PC 情報と、ここまでの AI 一次対応の履歴を根拠に回答します。</div>' +
      '<textarea id="ahdCaseAiInput" class="u-in" rows="2" placeholder="例：この状態で次に確認すべきことは？"></textarea>' +
      '<div class="ahd-row"><button class="u-btn pri" data-act="wAskCase"' +
      (AH.caseAiBusy ? ' disabled' : '') +
      '>' +
      (AH.caseAiBusy ? '回答中…' : 'AI に聞く') +
      '</button></div>' +
      '</div>'
    );
  }

  async function ahAskCase() {
    const c = ahCurrentCase();
    if (!c || AH.caseAiBusy) return;
    const input = document.getElementById('ahdCaseAiInput');
    const text = String((input && input.value) || '').trim();
    if (!text) {
      if (typeof toast === 'function') toast('聞きたいことを入力してください');
      return;
    }
    AH.caseAiBusy = true;
    uxRender();
    try {
      const data = await ahJsonFetch('/api/ai/answer-case', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId: c.id, text }),
      });
      const chat = S.chats.find((item) => item.id === c.chatId);
      if (chat) {
        addMsg(chat, { kind: 'user', text, at: nowISO() });
        const html = '<p>' + ahEsc(data.answer || '').replace(/\n/g, '<br>') + '</p>';
        ai(chat, html, {
          model: data.model || 'DeepSeek-V4.1-Flash',
          // 実 AI かフォールバックかを表示と報告書で判定する（honest-labels-bridge.js）。
          provider: data.provider,
          conf: data.confidence || '—',
          src: (data.sources || []).map((source) => source.kbNo),
        });
      }
      save();
      if (typeof toast === 'function') toast('AI が回答しました');
    } catch (error) {
      console.error('[assist] answer-case failed', error);
      if (typeof toast === 'function') {
        toast('AI の回答に失敗しました：' + String(error.message || error).slice(0, 120), 'bad');
      }
    } finally {
      AH.caseAiBusy = false;
      uxRender();
    }
  }

  function ahInjectHome() {
    const u = ahUser();
    if (!u) return;
    ahFetchHandoverInbox();
    const pending = (S.cases || []).filter(
      (item) => item.userId === u.id && item.remote && item.remote.status === 'requested',
    );
    const handovers = AH.handoverInbox || [];
    let box = document.getElementById('ahdHomeNotice');
    if (!pending.length && !handovers.length) {
      if (box) box.remove();
      return;
    }
    const page = document.getElementById('uxPage');
    if (!page) return;
    const root = page.querySelector('.u-page') || page;
    if (!box) {
      box = document.createElement('div');
      box.id = 'ahdHomeNotice';
      box.className = 'ahd-box ahd-consent';
      root.insertBefore(box, root.firstChild);
    }
    let html = '';
    if (pending.length) {
      html +=
        '<h4>🛟 遠隔支援の依頼が届いています</h4>' +
        pending
          .map(
            (item) =>
              '<div class="ahd-msg"><b>' +
              ahEsc(item.remote.requestedBy || '担当者') +
              '</b> さんから、案件 <span class="u-mono">' +
              ahEsc(item.id) +
              '</span> の遠隔支援を依頼されています。 <button class="u-btn sm" data-act="wOpen" data-id="' +
              ahEsc(item.id) +
              '">確認する</button></div>',
          )
          .join('');
    }
    if (handovers.length) {
      html +=
        '<h4>📥 DX 推進部への引継ぎ案件</h4>' +
        handovers
          .map(
            (item) =>
              '<div class="ahd-msg"><b>' +
              ahEsc(item.subject || '(件名なし)') +
              '</b>　' +
              ahEsc(item.requester || '') +
              (item.assigneeHint
                ? '　宛先: ' + ahEsc(item.assigneeHint)
                : '　宛先: DX 推進部グループ') +
              '<br><span class="u-mono">' +
              ahEsc(item.caseId) +
              '</span> <button class="u-btn sm" data-act="wClaimHandover" data-id="' +
              ahEsc(item.id) +
              '">引き受ける</button></div>',
          )
          .join('');
    }
    box.innerHTML = html;
  }

  function ahInject() {
    if (AH.injecting) return;
    if (typeof S === 'undefined' || !S) return;
    const screen = S.ui.screen || 'home';
    if (screen === 'home') {
      ahInjectHome();
      return;
    }
    const notice = document.getElementById('ahdHomeNotice');
    if (notice) notice.remove();
    if (screen !== 'wizard') return;
    const pane = document.getElementById('wzPane');
    if (!pane) return;
    let c = null;
    try {
      c = curCase();
    } catch (error) {
      c = null;
    }
    if (!c) return;
    const L = link(c);
    const html = ahAssistHtml(c, L);
    let box = document.getElementById('ahdAssistBox');
    if (!html) {
      if (box) box.remove();
      return;
    }
    AH.injecting = true;
    try {
      if (!box) {
        box = document.createElement('div');
        box.id = 'ahdAssistBox';
        pane.appendChild(box);
      }
      box.innerHTML = html;
    } finally {
      AH.injecting = false;
    }
  }

  // --- actions -----------------------------------------------------------
  function ahCurrentCase() {
    try {
      return curCase();
    } catch (error) {
      return null;
    }
  }

  function ahRequestRemote(c) {
    const u = ahUser();
    const L = link(c);
    if (!u || !isHdRole(u) || u.id === c.userId) return;
    if (!L.inc || (L.inc.status !== 'escalated' && L.inc.status !== 'in_progress')) {
      if (typeof toast === 'function') toast('引継ぎ後の案件で依頼できます');
      return;
    }
    if (c.remote && c.remote.status === 'approved') {
      if (typeof toast === 'function') toast('すでに遠隔支援中です');
      return;
    }
    c.remote = {
      status: 'requested',
      requestedBy: u.name,
      requestedAt: ahNow(),
      expiresAt: ahAfter(24 * 60 * 60 * 1000),
      scope:
        '読み取り情報の共有 + 案内文の送信 + RSP コンソールでの操作支援（画面録画は行いません。端末操作のログは RSP のコマンド実行に残ります）',
      prompts: [],
    };
    if (typeof auditAdd === 'function')
      auditAdd(S, u.id, 'remote_requested', { case: c.id, inc: L.inc.id });
    save();
    uxRender();
    if (typeof toast === 'function') toast('本人に遠隔支援を依頼しました。承認を待っています');
  }

  function ahApproveRemote(c) {
    const u = ahUser();
    if (!u || u.id !== c.userId) return;
    const remote = ahEnsureRemote(c);
    if (!remote || remote.status !== 'requested') return;
    remote.status = 'approved';
    remote.approvedBy = u.name;
    remote.approvedAt = ahNow();
    remote.expiresAt = ahAfter(30 * 60 * 1000);
    if (typeof auditAdd === 'function') auditAdd(S, u.id, 'remote_approved', { case: c.id });
    save();
    uxRender();
    if (typeof toast === 'function') toast('遠隔支援を承認しました（30分）');
  }

  function ahDenyRemote(c) {
    const u = ahUser();
    if (!u || u.id !== c.userId) return;
    const remote = ahEnsureRemote(c);
    if (!remote || remote.status !== 'requested') return;
    remote.status = 'denied';
    remote.endedAt = ahNow();
    if (typeof auditAdd === 'function') auditAdd(S, u.id, 'remote_denied', { case: c.id });
    save();
    uxRender();
    if (typeof toast === 'function') toast('遠隔支援を断りました');
  }

  function ahEndRemote(c) {
    const remote = c.remote;
    if (!remote) return;
    remote.status = 'ended';
    remote.endedAt = ahNow();
    if (typeof auditAdd === 'function')
      auditAdd(S, (ahUser() || {}).id || 'system', 'remote_ended', { case: c.id });
    save();
    uxRender();
    if (typeof toast === 'function') toast('遠隔支援を終了しました');
  }

  async function ahDraftRemote(c) {
    const remote = ahEnsureRemote(c);
    if (!remote || remote.status !== 'approved') return;
    const intent = (document.getElementById('ahdRemoteIntent') || {}).value || AH.intent || '';
    if (!String(intent).trim()) {
      if (typeof toast === 'function') toast('担当者の意図を入力してください');
      return;
    }
    AH.intent = String(intent);
    AH.remoteDrafting = true;
    uxRender();
    try {
      const context = {
        caseId: c.id,
        subject: (c.subject || '').slice(0, 500),
        body: (c.body || '').slice(0, 8000),
        pcSummary: ahPcSummary(c),
        priorPrompts: (remote.prompts || []).slice(-5).map((prompt) => prompt.text),
      };
      const response = await fetch('/api/ai/remote-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: AH.intent, context }),
      });
      if (!response.ok) throw new Error(await ahApiError(response));
      const data = await response.json();
      AH.draft = {
        caseId: c.id,
        text: (data.draft && data.draft.message) || '',
        actions: (data.draft && data.draft.actions) || [],
        provider: data.draft && data.draft.provider,
      };
    } catch (error) {
      console.error('[assist] remote draft failed', error);
      if (typeof toast === 'function') {
        toast(
          '案内文の下書きに失敗しました：' +
            String(error && error.message ? error.message : error).slice(0, 120),
          'bad',
        );
      }
    } finally {
      AH.remoteDrafting = false;
      uxRender();
    }
  }

  function ahSendPrompt(c) {
    const u = ahUser();
    const remote = ahEnsureRemote(c);
    if (!u || !remote || remote.status !== 'approved' || !isHdRole(u) || u.id === c.userId) return;
    const textarea = document.getElementById('ahdRemoteText');
    const text = String((textarea && textarea.value) || (AH.draft && AH.draft.text) || '').trim();
    if (!text) {
      if (typeof toast === 'function') toast('送る案内文を入力してください');
      return;
    }
    // 担当者が手で追記した連絡先なども、保存前に伏せ字化する。
    let safePrompt = text;
    try {
      if (typeof dlpMask === 'function') safePrompt = dlpMask(text).text;
    } catch (error) {
      safePrompt = text;
    }
    safePrompt = ahMaskPII(safePrompt);
    remote.prompts = remote.prompts || [];
    remote.prompts.push({
      id: 'RP-' + Date.now().toString(36),
      by: u.name,
      role: (typeof ROLES !== 'undefined' && ROLES[u.role]) || u.role,
      text: safePrompt.slice(0, 4000),
      at: ahNow(),
      status: 'sent',
    });
    if (typeof auditAdd === 'function') {
      auditAdd(S, u.id, 'remote_prompt_sent', { case: c.id, len: safePrompt.length });
    }
    AH.draft = null;
    AH.intent = '';
    save();
    uxRender();
    if (typeof toast === 'function') toast('本人の画面に案内を送りました');
  }

  function ahPromptResult(c, id, done) {
    const u = ahUser();
    const remote = c.remote;
    if (!u || !remote || u.id !== c.userId) return;
    const prompt = (remote.prompts || []).find((item) => item.id === id);
    if (!prompt) return;
    prompt.status = done ? 'done' : 'failed';
    prompt.doneAt = ahNow();
    if (typeof auditAdd === 'function') {
      auditAdd(S, u.id, done ? 'remote_prompt_done' : 'remote_prompt_failed', { case: c.id, id });
    }
    save();
    uxRender();
    if (typeof toast === 'function')
      toast(done ? '実施したことを記録しました' : '実施できなかったことを記録しました');
  }

  function ahDiscardDraft() {
    AH.draft = null;
    AH.intent = '';
    uxRender();
  }

  Object.assign(ACT, {
    wReport(d) {
      const c = ahCurrentCase();
      if (!c) return;
      void ahExport(c, d.fmt === 'pdf' ? 'pdf' : 'html');
    },
    wRemoteRequest() {
      const c = ahCurrentCase();
      if (c) ahRequestRemote(c);
    },
    wRemoteApprove() {
      const c = ahCurrentCase();
      if (c) ahApproveRemote(c);
    },
    wRemoteDeny() {
      const c = ahCurrentCase();
      if (c) ahDenyRemote(c);
    },
    wRemoteEnd() {
      const c = ahCurrentCase();
      if (c) ahEndRemote(c);
    },
    wRemoteDraft() {
      const c = ahCurrentCase();
      if (c) void ahDraftRemote(c);
    },
    wRemoteSend() {
      const c = ahCurrentCase();
      if (c) ahSendPrompt(c);
    },
    wRemoteDiscard() {
      ahDiscardDraft();
    },
    wRemotePromptDone(d) {
      const c = ahCurrentCase();
      if (c) ahPromptResult(c, d.id, true);
    },
    wRemotePromptFailed(d) {
      const c = ahCurrentCase();
      if (c) ahPromptResult(c, d.id, false);
    },
    wClaimHandover(d) {
      void ahClaimHandover(d.id);
    },
    wAskCase() {
      void ahAskCase();
    },
  });

  // 引継ぎ（A さん）: 同意して引き継いだ直後に、DX 推進部グループへ共有する。
  const ahOriginalConsent = ACT.wConsent;
  if (typeof ahOriginalConsent === 'function') {
    ACT.wConsent = function (d, el, event) {
      const result = ahOriginalConsent.call(this, d, el, event);
      setTimeout(() => void ahOpenShareDialog(), 700);
      return result;
    };
  }

  // --- style -------------------------------------------------------------
  function ahInstallStyle() {
    if (document.getElementById('ahd-assist-style')) return;
    const style = document.createElement('style');
    style.id = 'ahd-assist-style';
    style.textContent = [
      '.ahd-box{margin-top:12px;border:1px solid var(--u-line,#d9e2ec);border-radius:10px;padding:12px;background:var(--u-panel,#fff)}',
      '.ahd-box h4{margin:0 0 6px;font-size:14px}',
      '.ahd-box h5{margin:10px 0 4px;font-size:13px}',
      '.ahd-box .u-fl{margin-top:8px}',
      '.ahd-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.ahd-msg{font-size:12px;color:var(--u-muted,#616e7c);margin-top:5px;line-height:1.6}',
      '.ahd-note{font-size:12px;background:var(--u-bg,#f5f7fa);border-left:3px solid var(--u-line,#cbd2d9);padding:6px 8px;border-radius:4px;margin-top:6px}',
      '.ahd-banner{font-size:12px;font-weight:700;background:#eefaf2;color:#1d7a4d;border:1px solid #b7e4c7;border-radius:6px;padding:6px 8px;margin:4px 0}',
      '.ahd-prompt{border:1px solid var(--u-line,#d9e2ec);border-radius:8px;padding:8px;margin:6px 0;font-size:12px;line-height:1.65}',
      '.ahd-prompt.done{border-color:#b7e4c7;background:#f6fdf8}',
      '.ahd-prompt.failed{border-color:#f3c1bd;background:#fff7f6}',
      '.ahd-pill{display:inline-block;border:1px solid var(--u-line,#9aa5b1);border-radius:999px;padding:0 8px;margin:2px 0;font-size:11px;color:var(--u-ink,#1f2933)}',
      '.ahd-consent{border-color:#f0d38a;background:#fffdf5}',
      '.ahd-overlay{position:fixed;inset:0;background:rgba(15,23,32,.45);display:flex;align-items:center;justify-content:center;z-index:9999}',
      '.ahd-modal{background:var(--u-panel,#fff);border-radius:12px;padding:16px;max-width:520px;width:calc(100% - 40px);box-shadow:0 12px 40px rgba(0,0,0,.25);font-size:13px}',
      '.ahd-modal h4{margin:0 0 8px;font-size:15px}',
      '.ahd-f{display:flex;flex-direction:column;gap:4px;font-size:12px;margin-top:10px}',
    ].join('\n');
    document.head.appendChild(style);
  }

  // --- install -----------------------------------------------------------
  function ahInstall() {
    ahInstallStyle();
    // 監査ログ・最近の動きに、遠隔支援と報告書の操作を日本語で表示する。
    if (typeof EV !== 'undefined' && EV) {
      Object.assign(EV, {
        report_exported: '最終報告書を出力',
        remote_requested: '遠隔支援を依頼',
        remote_approved: '遠隔支援を承認',
        remote_denied: '遠隔支援を断る',
        remote_ended: '遠隔支援を終了',
        remote_expired: '遠隔支援が期限切れ',
        remote_prompt_sent: '本人へ案内を送信',
        remote_prompt_done: '案内を実施',
        remote_prompt_failed: '案内を実施できず',
      });
    }

    const origRender = window.uxRender;
    if (typeof origRender === 'function') {
      window.uxRender = function () {
        const result = origRender.apply(this, arguments);
        setTimeout(ahInject, 0);
        return result;
      };
    }
    const origSoft = window.wizSoft;
    if (typeof origSoft === 'function') {
      window.wizSoft = function () {
        const result = origSoft.apply(this, arguments);
        setTimeout(ahInject, 0);
        return result;
      };
    }

    const originalAutoAdvance = window.autoAdvance;
    if (typeof originalAutoAdvance === 'function') {
      window.autoAdvance = function (c, L) {
        // 引継ぎ直後は STEP 3（AI 一次対応）を開いたままにする。
        // ここで 3→4 に自動で進めると、B さんが AI 履歴を見られない。
        if (c && c.shared && c.step === 3) return;
        return originalAutoAdvance.apply(this, arguments);
      };
    }

    ahInstallKbLabels();

    const app = window.App;
    if (app) {
      const originalResolve = app.resolve;
      if (typeof originalResolve === 'function') {
        app.resolve = function () {
          const result = originalResolve.apply(this, arguments);
          setTimeout(() => void ahSyncHandoverStatus('resolved'), 900);
          return result;
        };
      }
      // ナレッジ承認は approver ロールの保持者。共有案件の承認はサーバーで
      // 権限（approver）と状態（引き受け済み）を確認してから実行する。
      const originalApprove = app.approve;
      if (typeof originalApprove === 'function') {
        app.approve = function (id) {
          const target = ahSharedCaseForDraft(id);
          if (!target || !target.handoverId) {
            // 引継ぎ案件ではない下書きも、承認をサーバーへ永続化する（F-06）。
            return ahApproveLocalKnowledge(id, originalApprove, this, arguments);
          }
          if (AH.approving) {
            if (typeof toast === 'function') toast('承認を確認しています…');
            return undefined;
          }
          // F-12: クライアント検証（申請者の分離・チェックリスト4件）を先に済ませる。
          // 不成立のままサーバー承認を先に実行すると status=completed になり、
          // 以後 409 NOT_CLAIMED で再承認できなくなる。
          // 判定できない場合はブロックせず従来動作に任せる（回帰防止）。
          const draftBefore = ahDraftInfo(id);
          const canInspect = Boolean(draftBefore);
          const blocked = ahClientApproveBlockReason(id);
          if (blocked) {
            if (typeof toast === 'function') toast(blocked, 'bad');
            return undefined;
          }
          AH.approving = true;
          const args = arguments;
          const handoverId = target.handoverId;
          // 引継ぎの承認は案件の完了で、KB の公開ではない。公開は ui-sync で別に保存する。
          // 原本の承認処理が画面を描き直す前に、チェックリストと本文を控える。
          const kbFull =
            window.HD && typeof window.HD.draftForSync === 'function'
              ? window.HD.draftForSync(id)
              : null;
          const kbChecklist = ahApproveChecklistValues();
          const kbComment = ahApproveComment();
          ahJsonFetch('/api/case-handovers/' + encodeURIComponent(handoverId) + '/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          })
            .then((data) => {
              // サーバー承認が成立した後にローカル承認（画面の反映）を行う。
              let localError = null;
              try {
                originalApprove.apply(this, args);
              } catch (error) {
                localError = error;
              }
              // 内部状態を参照できる場合だけ成否を判定する。参照できない場合は
              // 従来どおりローカル実行結果をそのまま扱う（誤検知で補償しない）。
              let localApproved = true;
              if (canInspect) {
                const after = ahDraftInfo(id);
                localApproved = Boolean(after && after.status === 'approved' && after.kbId);
              }
              if (!localApproved) {
                // 画面側が失敗しても引継ぎを completed のまま放置せず、再承認できる状態へ戻す。
                return ahRecoverHandoverAfterLocalApproveFailure(handoverId, localError);
              }
              const approved = data && data.handover ? data.handover : {};
              return ahPublishKnowledgeAfterHandover(kbFull, kbChecklist, kbComment).then((kb) => {
                if (!kb.published || !kb.aiUsable) {
                  ahCorrectReflectModal(
                    kb.published
                      ? AH_KB_NOT_FOR_AI + '。'
                      : 'ナレッジは公開されていません。AI の根拠にはなりません。',
                  );
                }
                const notice = ahHandoverApprovalNotice(approved, kb);
                if (typeof toast === 'function') toast(notice.text, notice.tone);
                return undefined;
              });
            })
            .catch((error) => {
              console.error('[assist] approve failed', error);
              if (typeof toast === 'function') {
                toast('承認できません：' + String(error.message || error).slice(0, 140), 'bad');
              }
            })
            .finally(() => {
              AH.approving = false;
            });
          return undefined;
        };

        // F-06: 承認申請（下書き→承認待ち）もサーバーへ残す。失敗しても画面操作は
        // 妨げない（承認時に改めて永続化する）。
        const originalSubmitDraft = app.submitDraft;
        if (typeof originalSubmitDraft === 'function') {
          app.submitDraft = function (id) {
            const result = originalSubmitDraft.apply(this, arguments);
            const full =
              window.HD && typeof window.HD.draftForSync === 'function'
                ? window.HD.draftForSync(id)
                : null;
            const draft = ahDraftInfo(id);
            if (full && draft && draft.status === 'review') {
              ahSyncKnowledge(full, 'pending').catch((error) => {
                console.error('[assist] knowledge sync (submit) failed', error);
                if (typeof toast === 'function') {
                  toast('ナレッジをサーバーへ保存できませんでした（承認時に再試行します）', 'bad');
                }
              });
            }
            return result;
          };
        }

        // F-06: 差戻しもサーバーへ残す（理由は画面のコメント欄）。
        const originalReturnDraft = app.returnDraft;
        if (typeof originalReturnDraft === 'function') {
          app.returnDraft = function (id) {
            const result = originalReturnDraft.apply(this, arguments);
            const full =
              window.HD && typeof window.HD.draftForSync === 'function'
                ? window.HD.draftForSync(id)
                : null;
            const draft = ahDraftInfo(id);
            if (full && draft && draft.status === 'returned') {
              ahSyncKnowledge(full, 'rejected', { comment: ahApproveComment() }).catch((error) => {
                console.error('[assist] knowledge sync (return) failed', error);
                if (typeof toast === 'function') {
                  toast('差戻しをサーバーへ保存できませんでした', 'bad');
                }
              });
            }
            return result;
          };
        }

        // F-06 不足分: ⑥ 承認者の確認を表示したらサーバ下書きを取得する。
        const originalGo = app.go;
        if (typeof originalGo === 'function') {
          app.go = function () {
            const result = originalGo.apply(this, arguments);
            setTimeout(ahSyncPendingSection, 30);
            return result;
          };
        }
      }
    }

    // F-06 不足分: 承認者向けサーバ下書きセクションの差し込みと操作。
    document.addEventListener('click', ahHandlePendingClick, true);
    document.addEventListener('change', ahHandlePendingChange, true);
    const hdMainElement = document.getElementById('hdMain');
    if (hdMainElement && typeof MutationObserver === 'function') {
      let pendingScheduled = false;
      const pendingObserver = new MutationObserver(() => {
        if (pendingScheduled) return;
        pendingScheduled = true;
        setTimeout(() => {
          pendingScheduled = false;
          ahSyncPendingSection();
        }, 60);
      });
      pendingObserver.observe(hdMainElement, { childList: true });
    }
    setTimeout(ahSyncPendingSection, 800);

    const page = document.getElementById('uxPage');
    if (page && typeof MutationObserver === 'function') {
      let scheduled = false;
      const observer = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
          scheduled = false;
          ahInject();
        }, 0);
      });
      observer.observe(page, { childList: true });
    }

    setTimeout(ahInject, 0);
    setTimeout(ahInject, 300);
    window.addEventListener('load', () => setTimeout(ahInject, 0));
    document.addEventListener('click', () => setTimeout(ahInject, 30), true);

    // F-13: 依頼者側の画面にもサーバの引継ぎ状態（対応中／完了）を反映する。
    // 起動時・再表示時（タブ復帰/フォーカス）・定期（45秒）に取得する。
    ahInstallHandoverLinkOverlay();
    const ahSyncHandoverSoon = () => {
      if (Date.now() - AH.handoverStatusSyncedAt < 5_000) return;
      void ahSyncHandoverStatuses();
    };
    setTimeout(() => void ahSyncHandoverStatuses(), 1_200);
    setInterval(() => void ahSyncHandoverStatuses(), 45_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') ahSyncHandoverSoon();
    });
    window.addEventListener('focus', ahSyncHandoverSoon);

    console.log('[assist] loaded');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ahInstall);
  } else {
    ahInstall();
  }
})();
