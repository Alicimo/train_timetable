const trafficInfoUrl = 'https://www.wienerlinien.at/ogd_realtime/trafficInfoList'
    + '?relatedLine=U1&name=stoerunglang&name=stoerungkurz';

function noticeDate(value) {
    const date = Date.parse(value);
    return Number.isFinite(date) ? new Date(date).toISOString() : null;
}

async function fetchU1Status({signal, now = Date.now, request = fetch} = {}) {
    const response = await request(trafficInfoUrl, {
        headers: {Accept: 'application/json'},
        signal
    });
    if (!response.ok) {
        throw new Error(`Wiener Linien returned HTTP ${response.status}`);
    }

    const {data, message} = await response.json();
    if (message?.messageCode !== 1 || !Array.isArray(data?.trafficInfos)
        || (data.trafficInfos.length && !Array.isArray(data.trafficInfoCategories))) {
        throw new Error('Invalid Wiener Linien disruption response');
    }

    const checkedAt = new Date(now()).toISOString();
    const categories = new Map((data.trafficInfoCategories ?? []).map(({id, name}) => [id, name]));
    const notices = new Map();
    for (const notice of data.trafficInfos) {
        const category = categories.get(notice.refTrafficInfoCategoryId);
        const detailed = category === 'stoerunglang';
        if ((!detailed && category !== 'stoerungkurz')
            || !Array.isArray(notice.relatedLines) || !notice.relatedLines.includes('U1')
            || (notice.status !== 'active' && (detailed || notice.status != null))) {
            continue;
        }

        const startsAt = noticeDate(notice.time?.start);
        const endsAt = noticeDate(notice.time?.end);
        if ((startsAt && startsAt > checkedAt) || (endsAt && endsAt <= checkedAt)) {
            continue;
        }

        const id = notice.name;
        const title = notice.title?.trim();
        const description = notice.description?.trim() || '';
        if (id && title) {
            notices.set(id, {id, detailed, title, description, startsAt, endsAt});
        }
    }

    return {checkedAt, notices: [...notices.values()]};
}

module.exports = {fetchU1Status};
