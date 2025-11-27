(async function () {
    try {
        const [recordRes, problemRes] = await Promise.all([
            fetch('./data/record.json'),
            fetch('./data/probleminfo.json')
        ]);
        if (!recordRes.ok || !problemRes.ok) throw new Error('파일 응답 오류');
        const records = await recordRes.json(); // 배열
        const problems = await problemRes.json(); // 배열

        // probleminfo를 빠른 조회용 맵으로 변환: map[problem_id][hold_id] -> {x,y}
        const problemMap = {};
        for (const p of problems) {
            if (!problemMap[p.problem_id]) problemMap[p.problem_id] = {};
            problemMap[p.problem_id][p.hold_id] = { x: Number(p.x), y: Number(p.y) };
        }

        // Catmull-Rom -> Cubic Bezier 기반 스무딩 함수
        // points: [[x,y], ...], tension: 0..1 (클수록 더 휘게)
        function buildSmoothPath(points, tension = 0.5) {
            if (!points || points.length === 0) return '';
            const t = Number(tension) || 0.5;
            const pts = points.map(p => [Number(p[0]), Number(p[1])]);

            let d = `M ${pts[0][0]} ${pts[0][1]}`;
            if (pts.length === 1) return d;

            // 곡률 세기 조절 팩터 (숫자 키우면 더 과장된 곡선)
            const factor = t * 0.7;

            for (let i = 0; i < pts.length - 1; i++) {
                const p0 = i === 0 ? pts[0] : pts[i - 1];
                const p1 = pts[i];
                const p2 = pts[i + 1];
                const p3 = (i + 2 < pts.length) ? pts[i + 2] : p2;

                const cp1x = p1[0] + (p2[0] - p0[0]) * factor;
                const cp1y = p1[1] + (p2[1] - p0[1]) * factor;
                const cp2x = p2[0] - (p3[0] - p1[0]) * factor;
                const cp2y = p2[1] - (p3[1] - p1[1]) * factor;

                d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`;
            }
            return d;
        }

        // 문자열(선수 이름)을 0 ~ 1 사이의 숫자로 바꾸는 간단한 해시
        function hashStringToUnit(str) {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
                hash = (hash * 31 + str.charCodeAt(i)) | 0;  // 간단한 정수 해시
            }
            // 음수일 수도 있으니 양수로 바꾼 뒤 0~1로 정규화
            const normalized = (hash >>> 0) / 0xFFFFFFFF; // 0 ~ 1
            return normalized;
        }

        // 완전 자동 tension 계산 함수
        // - athlete: 선수 이름 (문자열)
        // - attempt: 시도 번호 (숫자, 1부터 시작한다고 가정)
        function getTension(athlete, attempt) {
            // 1) 선수 이름 기반 기본 tension
            const baseRandom = hashStringToUnit(athlete || '');
            // 0.3 ~ 0.7 사이 값으로 매핑 (너무 과하게 휘지 않도록)
            let baseTension = 0.3 + baseRandom * 0.4;

            // 2) attempt 번호에 따라 살짝 보정
            //    시도가 늘어날수록 약간 더 휘게 (또는 반대로 하고 싶으면 -로)
            const att = Number(attempt) || 1;
            const attemptBoost = Math.min((att - 1) * 0.05, 0.15); // 1→0, 2→0.05, 3→0.10 ... 최대 +0.15

            let t = baseTension + attemptBoost;

            // 3) 최종 tension 클램프 (0.2~0.85 범위 안)
            if (t < 0.2) t = 0.2;
            if (t > 0.85) t = 0.85;

            return t;
        }


        const svg = document.getElementById('stage');
        // 컨트롤 생성 (문서 앞부분에 간단한 셀렉트 UI)
        // 🔍 현재 viewBox 상태 저장 (초기값은 HTML의 viewBox에서 가져옴)
        let viewBox = (function () {
            const vb = (svg.getAttribute('viewBox') || '0 0 1920 1080')
                .split(/[\s,]+/)
                .map(Number);
            return { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
        })();

        // 원본 viewBox 값을 저장해서 줌/팬의 한계를 잡을 때 사용
        const originalViewBox = { x: viewBox.x, y: viewBox.y, w: viewBox.w, h: viewBox.h };

        // 🔍 마우스 위치 기준 휠 줌
        svg.addEventListener('wheel', function (event) {
            event.preventDefault();  // 기본 스크롤 막기

            const rect = svg.getBoundingClientRect();
            const mx = event.clientX - rect.left; // SVG 안에서의 마우스 X (px)
            const my = event.clientY - rect.top;  // SVG 안에서의 마우스 Y (px)

            // deltaY 기준 줌 비율 계산
            // deltaY > 0 : 줌 아웃, deltaY < 0 : 줌 인
            const zoomSpeed = 0.001; // 민감도 (0.001 ~ 0.002 정도가 적당)
            const scale = Math.exp(event.deltaY * zoomSpeed); // >1 이면 확대 범위(줌 아웃)

            // 줌 한계: 더 이상 svg 원본 크기(또는 너무 작은 값)보다 커지지 않도록 제한
            const oldW = viewBox.w;
            const oldH = viewBox.h;

            let newW = oldW * scale;
            // aspect는 원본 viewBox 비율을 사용
            const aspect = originalViewBox.h / originalViewBox.w;
            let newH = newW * aspect;

            // 최소/최대 폭 제한
            const minW = originalViewBox.w / 10000; // 너무 크게 확대되는(=너무 작아보이는) 것 방지
            const maxW = originalViewBox.w; // 더 이상 줌 아웃하여 원본보다 큰 viewBox가 되지 않음

            if (newW < minW) newW = minW;
            if (newW > maxW) newW = maxW;
            newH = newW * aspect; // 재계산

            // 마우스 위치에 해당하는 SVG 좌표 (줌 전)
            const svgX = viewBox.x + (mx / rect.width) * oldW;
            const svgY = viewBox.y + (my / rect.height) * oldH;

            // 새 viewBox에서 마우스가 같은 화면 위치를 가리키도록 x,y 조정
            const newX = svgX - (mx / rect.width) * newW;
            const newY = svgY - (my / rect.height) * newH;

            // viewBox가 원본 영역을 벗어나지 않도록 클램프
            const minX = originalViewBox.x;
            const maxX = originalViewBox.x + originalViewBox.w - newW;
            const minY = originalViewBox.y;
            const maxY = originalViewBox.y + originalViewBox.h - newH;

            const clampedX = Math.min(Math.max(newX, minX), maxX);
            const clampedY = Math.min(Math.max(newY, minY), maxY);

            viewBox = { x: clampedX, y: clampedY, w: newW, h: newH };
            svg.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);
        }, { passive: false });

        // 🔄 드래그로 화면 이동(pan) — pointer 이벤트 기반 (마우스/터치 모두 지원)
        let isPanning = false;
        let panStart = { x: 0, y: 0 };
        let viewBoxStart = { x: viewBox.x, y: viewBox.y, w: viewBox.w, h: viewBox.h };
        let activePointerId = null;

        // 포인터 다운: SVG 내부에서만 시작
        svg.addEventListener('pointerdown', function (event) {
            // 마우스인 경우 왼쪽 버튼만 허용
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            isPanning = true;
            activePointerId = event.pointerId;
            panStart.x = event.clientX;
            panStart.y = event.clientY;
            viewBoxStart = { x: viewBox.x, y: viewBox.y, w: viewBox.w, h: viewBox.h };
            svg.style.cursor = 'move';
            // prevent default to avoid text selection / native gestures
            event.preventDefault();
        });

        // 포인터 무브: 현재 활성 포인터만 처리
        window.addEventListener('pointermove', function (event) {
            if (!isPanning) return;
            if (event.pointerId !== activePointerId) return;

            const rect = svg.getBoundingClientRect();

            // 커서/포인터가 SVG 바깥이면 즉시 드래그 종료
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
                isPanning = false;
                activePointerId = null;
                svg.style.cursor = 'default';
                return;
            }

            const dx = event.clientX - panStart.x;
            const dy = event.clientY - panStart.y;

            const dxSvg = dx / rect.width * viewBoxStart.w;
            const dySvg = dy / rect.height * viewBoxStart.h;

            viewBox.x = viewBoxStart.x - dxSvg;
            viewBox.y = viewBoxStart.y - dySvg;

            // viewBox가 원본 영역을 벗어나지 않도록 간단히 클램프 (줌 레벨에 따라 이미 적용된 제한과 함께 작동)
            const maxX = originalViewBox.x + originalViewBox.w - viewBox.w;
            const maxY = originalViewBox.y + originalViewBox.h - viewBox.h;
            viewBox.x = Math.min(Math.max(viewBox.x, originalViewBox.x), maxX);
            viewBox.y = Math.min(Math.max(viewBox.y, originalViewBox.y), maxY);

            svg.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);
        });

        // 포인터 업/취소: 현재 활성 포인터만 처리
        window.addEventListener('pointerup', function (event) {
            if (!isPanning) return;
            if (event.pointerId !== activePointerId) return;
            isPanning = false;
            activePointerId = null;
            svg.style.cursor = 'default';
        });

        window.addEventListener('pointercancel', function (event) {
            if (!isPanning) return;
            if (event.pointerId !== activePointerId) return;
            isPanning = false;
            activePointerId = null;
            svg.style.cursor = 'default';
        });

        // 추가 안전장치: 포인터가 SVG 요소 밖으로 나가면 드래그 종료
        svg.addEventListener('pointerleave', function (event) {
            if (!isPanning) return;
            if (event.pointerId !== activePointerId) return;
            isPanning = false;
            activePointerId = null;
            svg.style.cursor = 'default';
        });

        const controls = document.createElement('div');
        controls.className = 'controls';
        const problemSelect = document.createElement('select');
        const athleteSelect = document.createElement('select');
        const drawBtn = document.createElement('button');
        drawBtn.textContent = '그리기';
        drawBtn.style.marginLeft = '8px';
        const drawAllBtn = document.createElement('button');
        drawAllBtn.textContent = '모든 선수 그리기';
        drawAllBtn.style.marginLeft = '8px';
        const clearBtn = document.createElement('button');
        clearBtn.textContent = '초기화';
        clearBtn.style.marginLeft = '6px';
        const bottomBox = document.querySelector('.bottom-box');
        bottomBox.appendChild(controls);

        controls.appendChild(document.createTextNode('   athlete: '));
        controls.appendChild(athleteSelect);
        controls.appendChild(drawBtn);
        //controls.appendChild(drawAllBtn);// --- IGNORE ---
        controls.appendChild(clearBtn);

        // Tooltip for hover info
        const tooltip = document.createElement('div');
        tooltip.className = 'tooltip';
        tooltip.style.display = 'none';
        document.body.appendChild(tooltip);
        let activeGroup = null;

        function positionTooltip(event) {
            const offset = 15;
            tooltip.style.left = `${event.clientX + offset}px`;
            tooltip.style.top = `${event.clientY + offset}px`;
        }

        function showTooltip({ athlete, problem, attempt, limb }, event) {
            tooltip.textContent = '';
            const lines = [
                { label: '', value: athlete || '' },
                { label: 'problem', value: problem || '' },
                { label: 'attempt', value: attempt || '' },
                { label: 'limb', value: limb || '' }
            ];

            lines.forEach(({ label, value }, idx) => {
                const div = document.createElement('div');
                if (idx === 0) {
                    const strong = document.createElement('strong');
                    strong.textContent = value;
                    div.appendChild(strong);
                } else {
                    div.textContent = `${label}: ${value}`;
                }
                tooltip.appendChild(div);
            });
            tooltip.style.display = 'block';
            positionTooltip(event);
        }

        function hideTooltip() {
            tooltip.style.display = 'none';
        }

        function clearHighlights() {
            svg.querySelectorAll('.highlight').forEach(el => el.classList.remove('highlight'));
        }

        function highlightGroup({ athlete, problem, attempt }) {
            clearHighlights();
            activeGroup = { athlete, problem, attempt };
            svg.querySelectorAll('.attempt-line, .hold-dot').forEach(el => {
                if (
                    el.dataset.athlete === athlete &&
                    el.dataset.problem === problem &&
                    el.dataset.attempt === attempt
                ) {
                    el.classList.add('highlight');
                }
            });
        }

        function attachHoverEvents(el) {
            el.addEventListener('mouseenter', (event) => {
                const { athlete, problem, attempt, limb } = el.dataset;
                if (!athlete || !problem || !attempt || !limb) return;
                highlightGroup({ athlete, problem, attempt });
                showTooltip({ athlete, problem, attempt, limb }, event);
            });

            el.addEventListener('mousemove', (event) => {
                if (tooltip.style.display === 'block') {
                    positionTooltip(event);
                }
            });

            el.addEventListener('mouseleave', () => {
                const { athlete, problem, attempt, limb } = el.dataset;
                if (
                    activeGroup &&
                    activeGroup.athlete === athlete &&
                    activeGroup.problem === problem &&
                    activeGroup.attempt === attempt
                ) {
                    activeGroup = null;
                    clearHighlights();
                    hideTooltip();
                }
            });
        }

        // problem 목록: probleminfo 기준(또는 record에서 추출해도 됨)
        const problemIds = Array.from(new Set(problems.map(p => p.problem_id)));
        problemIds.forEach(pid => {
            const o = document.createElement('option'); o.value = pid; o.textContent = pid; problemSelect.appendChild(o);
        });

        function populateAthletes() {
            const seen = new Set();
            athleteSelect.innerHTML = '';
            for (const r of records) {
                if (!seen.has(r.athlete)) {
                    seen.add(r.athlete);
                    const o = document.createElement('option');
                    o.value = r.athlete;
                    o.textContent = r.athlete;
                    athleteSelect.appendChild(o);
                }
            }
            if (!athleteSelect.options.length) {
                const o = document.createElement('option');
                o.value = '';
                o.textContent = '(선수 없음)';
                athleteSelect.appendChild(o);
            }
        }

        // 기본 선택 설정
        populateAthletes();
        if (athleteSelect.options.length) {
            athleteSelect.selectedIndex = 0;
        }


        function clearDrawings() {
            clearHighlights();
            hideTooltip();
            activeGroup = null;
            svg.querySelectorAll('.attempt-line, .attempt-dot, .hold-dot').forEach(n => n.remove());
        }

        clearBtn.addEventListener('click', () => {
            drawAllProblemsAllAthletes();  // 다시 전체 난장판
        });


        // drawAthlete: 특정 선수의 모든 attempt+limb 조합을 그린다.

        // 모든 problem_id + 그 문제를 푼 모든 선수 루트를 한 번에 그리기
        function drawAllProblemsAllAthletes() {
            clearDrawings();  // 화면 싹 비우고 시작

            for (const pid of problemIds) {
                // 이 problem을 푼 선수 목록 (첫 등장 순서 유지)
                const seenAthletes = new Set();
                const athletes = [];
                for (const r of records) {
                    if (r.problem_id !== pid) continue;
                    if (!seenAthletes.has(r.athlete)) {
                        seenAthletes.add(r.athlete);
                        athletes.push(r.athlete);
                    }
                }

                // 각 선수 루트 그리기 (겹쳐서)
                for (const ath of athletes) {
                    drawAthlete(pid, ath, false); // clearFirst = false (겹쳐 그림)
                }
            }
        }
        // clearFirst: true이면 그리기 전에 기존 그림을 지운다. 기본 false.
        function drawAthlete(problemId, athlete, clearFirst = false) {
            if (clearFirst) clearDrawings();
            if (!problemId || !athlete) return;
            const holdMap = problemMap[problemId] || {};
            // groups는 등장 순서를 유지. key = "attempt::limb"
            const groups = [];
            for (const r of records) {
                if (r.problem_id !== problemId || r.athlete !== athlete) continue;
                const att = r.attempt;
                const limb = r.limb || r.hand || 'unknown';
                const key = `${att}::${limb}`;
                let g = groups.find(x => x.key === key);
                if (!g) { g = { key, attempt: att, limb, holds: [] }; groups.push(g); }
                g.holds.push(r.hold);
            }

            // 각 그룹(= attempt + limb)에 대해 점 + (필요하면) 선 생성
            for (const g of groups) {
                const pts = [];
                for (const hid of g.holds) {
                    const coord = holdMap[hid];
                    if (coord && Number.isFinite(coord.x) && Number.isFinite(coord.y)) {
                        pts.push([coord.x, coord.y]);
                    } else {
                        console.warn('매칭 실패:', problemId, hid);
                    }
                }
                if (pts.length === 0) continue;

                // ✅ 이 그룹(선수 + attempt)에 대한 tension 자동 계산
                const tension = getTension(athlete, g.attempt);

                // ① 모든 홀드에 점 찍기
                for (const [x, y] of pts) {
                    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    dot.setAttribute('cx', x);
                    dot.setAttribute('cy', y);
                    dot.setAttribute('r', 1);              // 점 크기 (원하면 2~4 사이로 조절)
                    dot.setAttribute('class', 'hold-dot'); // CSS에서 스타일 관리
                    dot.dataset.athlete = athlete;
                    dot.dataset.problem = problemId;
                    dot.dataset.attempt = g.attempt;
                    dot.dataset.limb = g.limb;
                    svg.appendChild(dot);
                    attachHoverEvents(dot);
                }

                // ② 홀드가 2개 이상인 경우에만 곡선 그리기
                if (pts.length >= 2) {
                    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    const d = buildSmoothPath(pts, tension);
                    path.setAttribute('d', d);
                    path.setAttribute('class', 'attempt-line'); // 선 스타일은 CSS에서
                    path.dataset.athlete = athlete;
                    path.dataset.problem = problemId;
                    path.dataset.attempt = g.attempt;
                    path.dataset.limb = g.limb;
                    svg.appendChild(path);
                    attachHoverEvents(path);
                }
            }

        }

        // 기존 draw 버튼 동작: 선택된 선수만 그리고 이전 그림은 지운다.
        drawBtn.addEventListener('click', () => {
            const chosenAthlete = athleteSelect.value;
            if (!chosenAthlete) return;

            clearDrawings();  // 기존 그림 지우고

            // 모든 problem에 대해 이 선수 루트 그리기
            for (const pid of problemIds) {
                drawAthlete(pid, chosenAthlete, false); // clearFirst = false
            }
        });


        // 새로운 기능: 해당 problem을 푼 모든 선수의 루트를 모두 그린다 (겹쳐서)
        drawAllBtn.addEventListener('click', () => {
            const chosenProblem = problemSelect.value;
            if (!chosenProblem) return;
            // original-order로 등장하는 선수 목록 추출 (첫 등장 순)
            const seen = new Set();
            const athletes = [];
            for (const r of records) {
                if (r.problem_id !== chosenProblem) continue;
                if (!seen.has(r.athlete)) {
                    seen.add(r.athlete);
                    athletes.push(r.athlete);
                }
            }
            // 각 선수에 대해 drawAthlete 호출. clear는 하지 않음 (겹쳐서 표시)
            for (const ath of athletes) {
                drawAthlete(chosenProblem, ath, false);
            }
        });

        // 초기 그리기: 페이지 켜자마자 모든 경기 + 모든 선수 난장판
        if (problemIds.length) {
            drawAllProblemsAllAthletes();
        }



    } catch (e) {
        console.error(e);
        alert('JSON 로드 실패: 콘솔을 확인하세요.');
    }
})();
