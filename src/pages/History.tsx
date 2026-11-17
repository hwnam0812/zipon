import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { ChevronLeft, ChevronRight, Info, RefreshCw } from "lucide-react";
import { useHome } from "../home/HomeProvider";
import { EmptyState, EventList, LoadingState, PageHeading, Pill, SafetyNote } from "../home/ui";
import { kstDay, type HomeEvent } from "../lib/home-model";

export default function History() {
  const { state, actions } = useHome();
  const [params, setParams] = useSearchParams();
  const today = kstDay(state.snapshot?.serverTime ?? Date.now());
  const date = params.get("date") ?? today;
  const rawType = params.get("type") ?? "all";
  const type = ["all", "door", "gas", "control", "fire", "siren"].includes(rawType) ? rawType : "all";
  const [page, setPage] = useState(0), [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ rows: HomeEvent[]; total: number } | null>(null);
  const [error, setError] = useState("");
  const update = (next: { date?: string; type?: string }) => {
    setPage(0); setParams({ date: next.date ?? date, type: next.type ?? type });
  };
  const stamp = `${state.snapshot?.events[0]?.id}:${state.snapshot?.sensor.fireStatus}:${state.snapshot?.command?.id}:${state.snapshot?.command?.status}:${state.snapshot?.sensor.board?.gasAlarm}:${state.snapshot?.outputCommands?.[0]?.id}:${state.snapshot?.outputCommands?.[0]?.status}`;
  const request = actions.request;
  useEffect(() => {
    const controller = new AbortController();
    setResult(null); setError("");
    void request<{ rows: HomeEvent[]; total: number }>(`/events?${new URLSearchParams({ date, type, offset: String(page * 50) })}`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setResult(data); })
      .catch(e => { if (!controller.signal.aborted) setError((e as Error).message); });
    return () => controller.abort();
  }, [date, type, page, request, revision, stamp]);
  const shift = (days: number) => {
    const value = Date.parse(`${date}T00:00:00+09:00`);
    if (Number.isFinite(value)) update({ date: kstDay(value + days * 86400_000) });
  };
  return <>
    <PageHeading title="출입·감지 기록" description="집의 작은 움직임을 시간순으로 확인해요." aside={<Pill>가족만 볼 수 있어요</Pill>}/>
    <div className="filter-bar"><div className="segment-control" aria-label="기록 종류">{[["all", "전체"], ["door", "현관문"], ["gas", "가스 출력"], ["control", "제어·설정"], ["fire", "이전 화재 징후"]].map(([value, label]) => <button key={value} type="button" aria-pressed={type === value} onClick={() => update({ type: value })}>{label}</button>)}</div><div><label className="field-label" htmlFor="history-date">조회 날짜 · 한국 시간</label><div className="date-filter"><button className="icon-button" type="button" onClick={() => shift(-1)} aria-label="이전 날짜"><ChevronLeft size={19}/></button><input id="history-date" type="date" value={date} max={today} min="2020-01-01" onChange={e => { if (e.target.value) update({ date: e.target.value }); }}/><button className="icon-button" type="button" disabled={date >= today} onClick={() => shift(1)} aria-label="다음 날짜"><ChevronRight size={19}/></button></div></div></div>
    <section className="panel history-panel"><div className="history-summary"><h2>{date === today ? "오늘의 기록" : date.replaceAll("-", ". ")}</h2><div className="flex items-center gap-3"><p>{result ? <>총 <b>{result.total.toLocaleString("ko-KR")}</b>건</> : "조회 중"}</p><button type="button" className="icon-button" aria-label="기록 새로 불러오기" onClick={() => setRevision(v => v + 1)}><RefreshCw size={15}/></button></div></div>
      {error ? <div className="empty-state" role="alert"><h3>기록을 불러오지 못했어요</h3><p>{error}</p><button className="text-button" type="button" onClick={() => setRevision(v => v + 1)}>다시 불러오기</button></div> : !result ? <LoadingState/> : result.rows.length ? <EventList events={result.rows}/> : <EmptyState title="이날 감지된 기록이 없어요" description="기기가 보낸 움직임만 남겨요. 다른 날짜나 기록 종류를 선택해 보세요."/>}
      {result && result.total > 50 && <div className="pagination"><span>{page * 50 + 1}–{Math.min((page + 1) * 50, result.total)} / {result.total.toLocaleString("ko-KR")}건</span><div><button type="button" className="icon-button" aria-label="이전 기록 페이지" disabled={!page} onClick={() => setPage(v => v - 1)}><ChevronLeft size={18}/></button><button type="button" className="icon-button" aria-label="다음 기록 페이지" disabled={(page + 1) * 50 >= result.total || page >= 100} onClick={() => setPage(v => v + 1)}><ChevronRight size={18}/></button></div></div>}
    </section>
    <div className="history-tip"><Info size={15}/><p>문을 누가 열었는지는 알 수 없어요. 시간은 앱 수신 기준이며 연결이 끊긴 동안의 움직임은 빠질 수 있어요. 가스 출력 이상은 실습 기준의 변화 기록이지 화재·누출 판정이 아니에요. 이전 센서의 화재 의심 기록도 그대로 보존해요.</p></div>
    <SafetyNote/>
  </>;
}
