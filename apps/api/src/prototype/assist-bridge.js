/*
 * AI HelpDesk assist bridge（最終報告書 + 遠隔支援コンソール）
 *
 * 既存プロトタイプ HTML は変更しない。このブリッジだけを追加する。
 * - STEP 3（AIで解決）/ STEP 5（担当者対応で解決）の完了時に、
 *   Standalone HTML / PDF の最終報告書を出力する。
 * - STEP 5 の引継ぎ後に、担当者（Bさん）が本人（Aさん）の同意を得て
 *   案内文を送る「遠隔支援コンソール」を追加する。
 *   画面の遠隔操作はせず、共有された PC 情報と案内文だけを扱う。
 *
 * 依存: paneHtml / wizSoft / uxRender / curCase / link / me / isHdRole など
 * （同じ classic script のグローバル lexical 環境から参照する）
 */
(() => {
  if (window.__AIHD_ASSIST_BRIDGE__) return;
  window.__AIHD_ASSIST_BRIDGE__ = { version: 1, at: new Date().toISOString() };

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
        if (text) out.push({ at, role: 'ai', who: message.who || 'AI', text });
      } else if (message.kind === 'kb') {
        out.push({
          at,
          role: 'ai',
          who: 'AI',
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
      .filter((message) => message.kind === 'diag')
      .slice(-50)
      .map((message) => ({
        title: message.title || '端末の診断（読み取りのみ）',
        rows: (message.steps || []).map((step) => ({
          k: String(step[0] || ''),
          v: String(step[1] || ''),
          lv: step[2] === 'warn' || step[2] === 'ng' ? step[2] : 'ok',
        })),
      }));
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
        name: String(op.name || proposal.opId).slice(0, 200),
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
        if (message.kind === 'kb')
          push(message.at, 'AI', '承認済みナレッジを提示', message.kbId || '');
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
        model: ahModel(),
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
        model: ahModel(),
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

  function ahRspLinks() {
    return (
      '<div class="ahd-row" style="margin-top:8px">' +
      '<a class="u-btn" href="' +
      ahEsc(ahMeshUrl) +
      '" target="_blank" rel="noopener noreferrer">MeshCentralを開く</a>' +
      '<a class="u-btn" href="' +
      ahEsc(ahRspUrl) +
      '" target="_blank" rel="noopener noreferrer">RSPで開く</a>' +
      '</div>' +
      '<div class="ahd-msg">RSP / MeshCentral のログインは Entra ID です。端末はコンピュータ名で選んでください。' +
      'デバイス指定のセッション URL は Phase 2（RSP 統合 API）で自動化します。</div>'
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
        '<div class="ahd-msg">Aさんの同意を得て、共有された PC 情報と案内文だけを扱います。<b>画面の遠隔操作・ファイル閲覧・キー入力は行いません。</b></div>' +
        '<div class="ahd-msg">対象：' +
        ahEsc(ahName(c.userId)) +
        ' さん／' +
        ahEsc(L.inc.id) +
        '</div>' +
        '<div class="ahd-row"><button class="u-btn pri" data-act="wRemoteRequest">本人に遠隔支援を依頼</button></div>' +
        ahRspLinks() +
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
      (isHelper ? ahRspLinks() : '') +
      '<div class="ahd-msg">遠隔支援の依頼・承認・案内の送信は監査ログに記録します。</div>' +
      '</div>'
    );
  }

  function ahAssistHtml(c, L) {
    let html = '';
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
    if (AH.handoverLoaded || AH.handoverLoading) return;
    AH.handoverLoading = true;
    ahJsonFetch('/api/case-handovers/inbox')
      .then((data) => {
        AH.handoverInbox = Array.isArray(data.items) ? data.items : [];
      })
      .catch((error) => {
        // DX 以外は 403。エラー表示はせず、受信箱なしとして扱う。
        if (error.status !== 403) console.warn('[assist] handover inbox failed', error);
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
    const draft = draftId && typeof drById === 'function' ? drById(draftId) || null : null;
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
    if (!target) target = candidates[0] || null;
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
        '読み取り情報の共有 + 案内文の送信（画面の遠隔操作・ファイル閲覧・キー入力は含みません）',
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
      // ナレッジ承認は DX 推進部グループの誰か。共有案件の承認はサーバーで
      // 権限（DX 推進部）と状態（引き受け済み）を確認してから実行する。
      const originalApprove = app.approve;
      if (typeof originalApprove === 'function') {
        app.approve = function (id) {
          const target = ahSharedCaseForDraft(id);
          if (!target || !target.handoverId) return originalApprove.apply(this, arguments);
          if (AH.approving) {
            if (typeof toast === 'function') toast('承認を確認しています…');
            return undefined;
          }
          AH.approving = true;
          const args = arguments;
          ahJsonFetch('/api/case-handovers/' + encodeURIComponent(target.handoverId) + '/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          })
            .then((data) => {
              const result = originalApprove.apply(this, args);
              const approved = data && data.handover ? data.handover : {};
              if (typeof toast === 'function') {
                if (approved.selfApproved) {
                  toast(
                    '自分の対応した案件を自己承認しました（DX 推進部の別の担当者が承認することが望ましい）',
                    'bad',
                  );
                } else {
                  toast(
                    'ナレッジを承認しました（承認者: ' +
                      String(approved.approvedByName || '') +
                      '）',
                  );
                }
              }
              return result;
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
      }
    }

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
    console.log('[assist] loaded');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ahInstall);
  } else {
    ahInstall();
  }
})();
