// R7-c — 설정 행 `system_config`(SettingsStore 의 저장 자리 · 2026-10-08).
// 칸 이름은 Shopware `system_config` 와 같다 — 근거: CmhCore `src/Service/Installer/CmhCoreSeedInstaller.php:351-360`
//   (id · configuration_key · configuration_value(`json_encode(['_value' => …])`) · sales_channel_id · created_at) + DEFAULT_FIELDS(updated_at).
// 【AI 임시 결정 · 로컬 앱 DB 전용 · 서버 테이블 아님】 이 정의는 앱 SQLite 파일의 설정 행이다. 서버 Shopware 에도 같은 이름 테이블이 있지만
//   이 행을 서버로 sync 하지 않는다(R9 서버 모드 전환 때 따로 정한다). 서버 칸 길이 · collation · UNIQUE 이름은 이 저장소에서 확인하지 못했다.
import { defineEntity } from '../define-entity.js';
import type { EntityDefinition } from '../types.js';

export const systemConfigDefinition: EntityDefinition = defineEntity({
  entityName: 'system_config',
  fields: [
    // 【AI 임시 결정】 maxLength 255 — SettingsStore SETTINGS_KEY_MAX 와 같게(서버 칸 길이는 확인 못 함 · 로컬 SQLite 는 강제하지 않는다)
    { name: 'configuration_key', type: 'string', required: true, maxLength: 255 },
    // `{"_value": …}` — 서버 JsonField 처럼 json(드라이버가 객체 ↔ JSON 글로 바꾼다)
    { name: 'configuration_value', type: 'json', required: true },
    // sales_channel 은 로컬에 없는 Shopware 코어 테이블 → FK 제약 없이 id 칸만. 로컬은 늘 null(SettingsStore 가 null 아닌 행을 거부)
    { name: 'sales_channel_id', type: 'fk' },
  ],
  // 판매채널이 있는 행끼리의 UNIQUE. SQLite 는 NULL 끼리 같다고 보지 않으므로 «null 채널 키 하나» 는 마이그레이션의 부분 UNIQUE 색인이 막는다
  uniques: [['configuration_key', 'sales_channel_id']],
});

/** 로컬 앱 전용 정의 — createDefaultRegistry 가 cmh_ai_* 뒤에 등록한다 */
export const LOCAL_APP_DEFINITIONS: readonly EntityDefinition[] = [systemConfigDefinition];
