# トレーサビリティ・マトリクス（QA 2026-11-11）

- 生成: QA ワークベンチの登録内容から自動生成（読み取りのみ）
- 要件 23 件 / 用例 48 件

## 1. 要件 → 用例

| 要件ID | 区分 | 要件 | リンクされた用例 |
|---|---|---|---|
| `req_mwb2y9rc_0b9c47fb` | functional | 受入#1: README に MVP の目的・利用者・価値が記載されている | TC-A01 受入#1 README の目的・利用者・価値 |
| `req_mwb2y9rs_3cd1fda2` | functional | 受入#2/#5: 主要3FlowがE2Eで実行でき、正常状態で通し操作できる | TC-A02 受入#2 主要3FlowのE2E（dataflow-integration）<br>TC-A05 受入#5 Normal State（主要画面の正常表示） |
| `req_mwb2y9s7_7e246caf` | functional | 受入#3: 採用UI方針（既存プロトタイプHTML 100%配信）と主要画面が整合 | TC-A03 受入#3 配信HTMLと原本プロトタイプの差分 |
| `req_mwb2y9ss_735a78a9` | functional | 受入#4: Seed/Dummy Data で操作可能（users/knowledge/cases/PC項目） | TC-A04 受入#4 Seed/Dummy Data で操作可能 |
| `req_mwb2y9t8_7caa878a` | functional | 受入#6: Empty State（空状態）の体系的確認 | TC-A06a 受入#6 Empty State（案件0件の相談者）<br>TC-A06b 受入#6 Empty State（ヘルプデスクキューの空） |
| `req_mwb2y9tp_5984966a` | functional | 受入#7: Loading State（読込中）の体系的確認 | TC-A07a 受入#7 Loading State（初期表示の待機表示）<br>TC-A07b 受入#7 Loading State（PC基本情報の取得中） |
| `req_mwb2y9u8_d1f3d078` | functional | 受入#8/#9: UIのInput Error（入力エラー）とCommunication Error（通信エラー） | TC-A08a 受入#8 Input Error（空入力）<br>TC-A08b 受入#8 Input Error（長大入力の上限）<br>TC-A08c 受入#8 Input Error（不正な category のAPI拒否）<br>TC-A09 受入#9 Communication Error（API中断時の通知と再試行） |
| `req_mwb2yitr_b69eb238` | functional | 受入#10/#11: Migration と Seed が再実行可能（冪等） | TC-A10 受入#10 Migration の再実行（冪等）<br>TC-A11 受入#11 Seed の再実行（冪等・TRUNCATEなし） |
| `req_mwb2yiu3_3075ed39` | functional | 受入#12: DB 主要 Read/Write の確認 | TC-A12 受入#12 DB 主要 Read/Write の突合 |
| `req_mwb2yiuj_d9d0739c` | nonfunctional | 受入#13〜#16: TypeCheck/Lint/Test/Build の成功 | TC-A13 受入#13 TypeCheck 成功<br>TC-A14 受入#14 Lint 成功（error 0）<br>TC-A15 受入#15 主要 Test 成功（新規DB）<br>TC-A16 受入#16 Build 成功 |
| `req_mwb2yiuu_53244c05` | risk | 受入#17: Critical/High の既知問題なし（proxy unit 反映を含む） | TC-A17 受入#17 既知問題インベントリと proxy 反映の参照確認 |
| `req_mwb2yiv7_cf4b3a41` | functional | 受入#18/#19: 公開面の配備と主要画面（公開経路とローカル代替を区別） | TC-A18 受入#18 公開面の配備（未認証応答とローカル代替）<br>TC-A19 受入#19 公開面の主要画面（OTP後・人間必要） |
| `req_mwb2yivi_946e17f6` | functional | 受入#20/#21: 公開経路の API/DB 確認（認証後は未実施） | TC-A20 受入#20 公開経路の API（未認証とproxy health）<br>TC-A21 受入#21 公開経路の DB（接続確認と書込み未実施） |
| `req_mwb2yivu_29561c0b` | functional | 受入#22〜#29: 開発ドキュメント一式の更新・整合 | TC-A22 受入#22 README 更新（現況整合）<br>TC-A23 受入#23 Setup Documentation の整合<br>TC-A24 受入#24 Requirements 更新<br>TC-A25 受入#25 Design 更新（OpenDesign成果物）<br>TC-A26 受入#26 Database Documentation 更新<br>TC-A27 受入#27 API Documentation 更新<br>TC-A28 受入#28 Test Documentation 更新<br>TC-A29 受入#29 Deployment Documentation 更新 |
| `req_mwb2yiw9_57c43003` | functional | 受入#30〜#32: Limitations / Recovery / Backlog の整備 | TC-A30 受入#30 Limitations 記録<br>TC-A31 受入#31 Recovery / Rollback 手順の記録<br>TC-A32 受入#32 Future Feature / Backlog 整理 |
| `req_mwb2yr7f_8c6e67e5` | risk | D: 認証・認可がサーバ側で判定される（ロール・所有者・職務分離） | TC-D01 認証: 3ロールのログインとセッションCookie<br>TC-D02 認可マトリクス（未認証・他人・ロール・職務分離） |
| `req_mwb2yr7q_505b01ef` | risk | D: PII 伏せ字と Secret 非混入 | TC-D03 PII 伏せ字（案件・解決記録・ナレッジ下書き）<br>TC-D04 AI コンテキストからの IP/シリアル/資産番号/メール除外 |
| `req_mwb2yr85_4ddf3bab` | risk | D: 監査ハッシュ鎖の検証と改ざん検知 | TC-D05 監査ハッシュ鎖の検証と改ざん検知 |
| `req_mwb2yr8g_a91e737f` | risk | D: 解決ループ（/api/resolve/*）の承認・実行境界 | TC-D06 解決ループ: 承認ハッシュ不一致・期限切れの拒否<br>TC-D07 解決ループ: estop 中の開始・承認拒否<br>TC-D08 解決ループ: device 所有者と Skill 許可リスト |
| `req_mwb2yr8q_e312c7e9` | functional | B-1: dist-manifest --verify --root の回帰 | TC-B01 dist-manifest --verify --root の回帰 |
| `req_mwb2yr90_06ce656a` | risk | B-2: proxy unit の Wants= 削除と引き上げ防止 | TC-B02 proxy unit の Wants= 削除（repo と本番の参照確認） |
| `req_mwb2yr9b_687e7ff0` | functional | B-3: set-smtp-password の再起動対象決定の回帰 | TC-B03 set-smtp-password の再起動対象決定 |
| `req_mwb2yr9p_d3737f91` | functional | B-4: install-proxy-service.sh の health ゲート回帰 | TC-B04 install-proxy-service.sh の health ゲート（fake 環境） |

## 2. 用例一覧（48 件）

| 用例ID | タイトル | 種別 | 優先 | 状態 | 追跡 |
|---|---|---|---|---|---|
| `tc_mwb2zy0h_dafbd6cb` | TC-A01 受入#1 README の目的・利用者・価値 | other | P2 | draft | 受入 #1 / req_mwb2y9rc_0b9c47fb / docs/01 §1, docs/11 #1 |
| `tc_mwb2zy0x_387552fa` | TC-A02 受入#2 主要3FlowのE2E（dataflow-integration） | functional | P0 | draft | 受入 #2/#5 / req_mwb2y9rs_3cd1fda2 / FR-01,22,24,26,29-31 / BR-17 / docs/65 §0-1 |
| `tc_mwb2zy19_f91afbeb` | TC-A03 受入#3 配信HTMLと原本プロトタイプの差分 | interface | P1 | draft | 受入 #3 / req_mwb2y9s7_7e246caf / docs/01 冒頭, docs/14 |
| `tc_mwb2zy1k_9b8961c2` | TC-A04 受入#4 Seed/Dummy Data で操作可能 | functional | P1 | draft | 受入 #4 / req_mwb2y9ss_735a78a9 / docs/01 §5, docs/11 #4 / A-07 |
| `tc_mwb2zy1v_77c33d00` | TC-A05 受入#5 Normal State（主要画面の正常表示） | ui | P0 | draft | 受入 #5 / req_mwb2y9rs_3cd1fda2 / FR-01〜07 / docs/11 #5 |
| `tc_mwb2zy27_233ab625` | TC-A06a 受入#6 Empty State（案件0件の相談者） | ui | P1 | draft | 受入 #6 / req_mwb2y9t8_7caa878a / FR-06,37,38 / docs/11 #6 |
| `tc_mwb2zy2m_fbaef412` | TC-A06b 受入#6 Empty State（ヘルプデスクキューの空） | ui | P1 | draft | 受入 #6 / req_mwb2y9t8_7caa878a / FR-37,38 / docs/11 #6 |
| `tc_mwb30cjx_7f36b018` | TC-A07a 受入#7 Loading State（初期表示の待機表示） | ui | P1 | draft | 受入 #7 / req_mwb2y9tp_5984966a / FR-08 / docs/11 #7 |
| `tc_mwb30ckf_41ec758e` | TC-A07b 受入#7 Loading State（PC基本情報の取得中） | ui | P1 | draft | 受入 #7 / req_mwb2y9tp_5984966a / FR-08 / docs/01 §3 |
| `tc_mwb30ckq_f02068a2` | TC-A08a 受入#8 Input Error（空入力） | boundary | P0 | draft | 受入 #8 / req_mwb2y9u8_d1f3d078 / FR-03 / docs/06 §6 |
| `tc_mwb30cl1_a6dc7625` | TC-A08b 受入#8 Input Error（長大入力の上限） | boundary | P1 | draft | 受入 #8 / req_mwb2y9u8_d1f3d078 / FR-03 / docs/05 §2-1 |
| `tc_mwb30clb_aed8ef2a` | TC-A08c 受入#8 Input Error（不正な category のAPI拒否） | interface | P1 | draft | 受入 #8 / req_mwb2y9u8_d1f3d078 / docs/05 §6 / A-06 |
| `tc_mwb30cll_7a1e8f92` | TC-A09 受入#9 Communication Error（API中断時の通知と再試行） | ui | P1 | draft | 受入 #9 / req_mwb2y9u8_d1f3d078 / NFR-16 / docs/11 #9 |
| `tc_mwb30cm0_701d7bb8` | TC-A10 受入#10 Migration の再実行（冪等） | functional | P0 | draft | 受入 #10 / req_mwb2yitr_b69eb238 / docs/01 §5 / A-07 |
| `tc_mwb30cma_9b567ca3` | TC-A11 受入#11 Seed の再実行（冪等・TRUNCATEなし） | functional | P0 | draft | 受入 #11 / req_mwb2yitr_b69eb238 / docs/01 §5 / A-07 |
| `tc_mwb30sdh_09440de2` | TC-A12 受入#12 DB 主要 Read/Write の突合 | functional | P0 | draft | 受入 #12 / req_mwb2yiu3_3075ed39 / BR-18 / A-02/A-03/A-04 |
| `tc_mwb30se0_cf3d4ae5` | TC-A13 受入#13 TypeCheck 成功 | nonfunctional | P0 | draft | 受入 #13 / req_mwb2yiuj_d9d0739c / docs/06 §2 / A-08 |
| `tc_mwb30sei_12f6b758` | TC-A14 受入#14 Lint 成功（error 0） | nonfunctional | P0 | draft | 受入 #14 / req_mwb2yiuj_d9d0739c / docs/06 §2 / A-08 |
| `tc_mwb30sf2_1f750bcf` | TC-A15 受入#15 主要 Test 成功（新規DB） | nonfunctional | P0 | draft | 受入 #15 / req_mwb2yiuj_d9d0739c / docs/06 §2 / A-08 |
| `tc_mwb30sfi_06ffaf97` | TC-A16 受入#16 Build 成功 | nonfunctional | P0 | draft | 受入 #16 / req_mwb2yiuj_d9d0739c / docs/06 §2 / A-08 |
| `tc_mwb30sfz_bfd5155a` | TC-A17 受入#17 既知問題インベントリと proxy 反映の参照確認 | other | P0 | draft | 受入 #17 / req_mwb2yiuu_53244c05 / docs/85 U-5 / docs/89 / docs/91 |
| `tc_mwb30sgf_86acac58` | TC-A18 受入#18 公開面の配備（未認証応答とローカル代替） | interface | P1 | draft | 受入 #18 / req_mwb2yiv7_cf4b3a41 / docs/08 §0 / docs/85 / NFR-10 |
| `tc_mwb30sgt_f3f25619` | TC-A19 受入#19 公開面の主要画面（OTP後・人間必要） | ui | P1 | draft | 受入 #19 / req_mwb2yiv7_cf4b3a41 / docs/85 C-3 / docs/11 #19 |
| `tc_mwb30shc_3f6ce1c9` | TC-A20 受入#20 公開経路の API（未認証とproxy health） | interface | P1 | draft | 受入 #20 / req_mwb2yivi_946e17f6 / docs/11 #20 / docs/85 C-3 |
| `tc_mwb30shp_e301cc8f` | TC-A21 受入#21 公開経路の DB（接続確認と書込み未実施） | interface | P1 | draft | 受入 #21 / req_mwb2yivi_946e17f6 / docs/11 #21 / docs/88 |
| `tc_mwb3120g_9c8c045f` | TC-A22 受入#22 README 更新（現況整合） | other | P2 | draft | 受入 #22 / req_mwb2yivu_29561c0b / docs/11 #22 / A-11 |
| `tc_mwb3120x_4cc64857` | TC-A23 受入#23 Setup Documentation の整合 | other | P2 | draft | 受入 #23 / req_mwb2yivu_29561c0b / docs/11 #23 / A-11 |
| `tc_mwb3121a_bbfa0a34` | TC-A24 受入#24 Requirements 更新 | other | P2 | draft | 受入 #24 / req_mwb2yivu_29561c0b / docs/11 #24 / docs/01 |
| `tc_mwb3121n_fdfa40e7` | TC-A25 受入#25 Design 更新（OpenDesign成果物） | other | P2 | draft | 受入 #25 / req_mwb2yivu_29561c0b / docs/11 #25 / docs/14 |
| `tc_mwb31221_07a56f36` | TC-A26 受入#26 Database Documentation 更新 | other | P2 | draft | 受入 #26 / req_mwb2yivu_29561c0b / docs/11 #26 / docs/04 |
| `tc_mwb3122f_8f34b9c1` | TC-A27 受入#27 API Documentation 更新 | other | P2 | draft | 受入 #27 / req_mwb2yivu_29561c0b / docs/11 #27 / docs/05 |
| `tc_mwb318ro_8fcd9e3a` | TC-A28 受入#28 Test Documentation 更新 | other | P2 | draft | 受入 #28 / req_mwb2yivu_29561c0b / docs/11 #28 / docs/06 |
| `tc_mwb318s0_a185058a` | TC-A29 受入#29 Deployment Documentation 更新 | other | P2 | draft | 受入 #29 / req_mwb2yivu_29561c0b / docs/11 #29 / docs/08 |
| `tc_mwb318si_77324d9e` | TC-A30 受入#30 Limitations 記録 | other | P2 | draft | 受入 #30 / req_mwb2yiw9_57c43003 / docs/11 #30 / docs/07 §7 |
| `tc_mwb318sv_47213e1d` | TC-A31 受入#31 Recovery / Rollback 手順の記録 | other | P2 | draft | 受入 #31 / req_mwb2yiw9_57c43003 / docs/11 #31 / docs/08 §8 / docs/09 §4 |
| `tc_mwb318t8_e9ed1514` | TC-A32 受入#32 Future Feature / Backlog 整理 | other | P2 | draft | 受入 #32 / req_mwb2yiw9_57c43003 / docs/11 #32 / docs/10 |
| `tc_mwb329nq_54e40c1b` | TC-D01 認証: 3ロールのログインとセッションCookie | security | P0 | draft | D / req_mwb2yr7f_8c6e67e5 / docs/07 §2 / A-01 |
| `tc_mwb329o8_3336bb51` | TC-D02 認可マトリクス（未認証・他人・ロール・職務分離） | security | P0 | draft | D / req_mwb2yr7f_8c6e67e5 / docs/07 §3 / A-01 / BR-02 |
| `tc_mwb329om_bf6925d4` | TC-D03 PII 伏せ字（案件・解決記録・ナレッジ下書き） | security | P0 | draft | D / req_mwb2yr7q_505b01ef / docs/07 §4 / BR-06 / NFR-04 / A-09 |
| `tc_mwb329oy_a34312da` | TC-D04 AI コンテキストからの IP/シリアル/資産番号/メール除外 | security | P0 | draft | D / req_mwb2yr7q_505b01ef / docs/07 §4 / docs/05 §6-2 / BR-10 |
| `tc_mwb329pb_c7dfc9ed` | TC-D05 監査ハッシュ鎖の検証と改ざん検知 | security | P0 | draft | D / req_mwb2yr85_4ddf3bab / docs/07 §6 / BR-18 / NFR-13 / FR-41 |
| `tc_mwb329pn_348451e2` | TC-D06 解決ループ: 承認ハッシュ不一致・期限切れの拒否 | security | P0 | draft | D / req_mwb2yr8g_a91e737f / docs/05 §6-4 / BR-03 / NFR-01 |
| `tc_mwb329q0_e859f10a` | TC-D07 解決ループ: estop 中の開始・承認拒否 | security | P0 | draft | D / req_mwb2yr8g_a91e737f / docs/05 §6-4 / FR-23 / NFR-01 |
| `tc_mwb329q9_f10d7bde` | TC-D08 解決ループ: device 所有者と Skill 許可リスト | security | P0 | draft | D / req_mwb2yr8g_a91e737f / docs/05 §6-4 / BR-01 / NFR-01 |
| `tc_mwb32il7_80e5f464` | TC-B01 dist-manifest --verify --root の回帰 | functional | P1 | draft | B-1 / req_mwb2yr8q_e312c7e9 / docs/89 §3-1 / PR #156 |
| `tc_mwb32ill_dc5db1d4` | TC-B02 proxy unit の Wants= 削除（repo と本番の参照確認） | functional | P1 | draft | B-2 / req_mwb2yr90_06ce656a / docs/89 §3-2 / docs/91 / PR #156 |
| `tc_mwb32ilx_1cedbc04` | TC-B03 set-smtp-password の再起動対象決定 | functional | P1 | draft | B-3 / req_mwb2yr9b_687e7ff0 / docs/89 §3-3 / PR #156 |
| `tc_mwb32ima_c0495429` | TC-B04 install-proxy-service.sh の health ゲート（fake 環境） | functional | P1 | draft | B-4 / req_mwb2yr9p_d3737f91 / docs/89 §3-4 / PR #156 |

## 3. 未リンク確認

- 未リンク用例: 0 件
- 各用例は1要件以上にリンク済み（複数リンクあり）
