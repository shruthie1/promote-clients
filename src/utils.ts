import axios from "axios";
import { fetchWithTimeout } from "./fetchWithTimeout";
import { UserDataDtoCrud } from "./dbservice";
import { parseError } from "./parseError";

export interface IChannel {
  channelId: string;
  title: string;
  participantsCount: number;
  username: string;
  restricted: boolean;
  broadcast: boolean;
  sendMessages: boolean;
  canSendMsgs: boolean;
  wordRestriction?: number;
  dMRestriction?: number;
  availableMsgs?: string[];
  banned?: boolean;
  forbidden?: boolean;
  reactRestricted?: boolean;
  reactions?: string[];
  private?: boolean;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
export function contains(str, arr) {
  return (arr.some(element => {
    if (str?.includes(element)) {
      return true;
    }
    return false;
  }))
};

export function selectRandomElements<T>(array: T[], n: number): T[] {
  if (array) {
    const selectedElements: T[] = [];
    for (let i = 0; i < n; i++) {
      const randomIndex = Math.floor(Math.random() * array.length);
      selectedElements.push(array[randomIndex]);
    }
    return selectedElements;
  } else {
    return [];
  }
}

export function toBoolean(value: string | number | boolean): boolean {
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  return value
}

export function fetchNumbersFromString(inputString) {
  const regex = /\d+/g;
  const matches = inputString.match(regex);
  if (matches) {
    const result = matches.join('');
    return result;
  } else {
    return '';
  }
}

let botCount = 0;

export function ppplbot(chatId?: string, botToken?: string) {
  let token = botToken;

  if (!token) {
    if (botCount % 2 === 1) {
      token = 'bot6624618034:AAHoM3GYaw3_uRadOWYzT7c2OEp6a7A61mY';
    } else {
      token = 'bot6607225097:AAG6DJg9Ll5XVxy24Nr449LTZgRb5bgshUA';
    }
    botCount++;
  }
  const targetChatId = chatId || '-1001801844217'; // Replace with actual chat ID
  const apiUrl = `https://api.telegram.org/${token}/sendMessage?chat_id=${targetChatId}`;
  return apiUrl;
};

export const defaultReactions = [
  '❤', '🔥', '👏', '🥰', '😁', '🤔',
  '🤯', '😱', '🤬', '😢', '🎉', '🤩',
  '🤮', '💩', '🙏', '👌', '🕊', '🤡',
  '🥱', '🥴', '😍', '🐳', '❤‍🔥', '💯',
  '🤣', '💔', '🏆', '😭', '😴', '👍',
  '🌚', '⚡', '🍌', '😐', '💋', '👻',
  '👀', '🙈', '🤝', '🤗', '🆒',
  '🗿', '🙉', '🙊', '🤷', '👎'
]
export const defaultMessages = [
  "1", "2", "3", "4", "5", "6", "7", "8",
  "9", "10", "11", "12", "13", "14", "15",
  "16", "17", "18", "19"
];

export async function startNewUserProcess(error: any, clientId: string) {
  if (error.errorMessage == 'CONNECTION_NOT_INITED' || error.errorMessage == 'AUTH_KEY_DUPLICATED') {
    await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}-${clientId}: AUTH KEY DUPLICATED : Deleting Archived Client`);
    console.log("AUTH KEY DUPLICATED : Deleting Archived Client")
    await axios.delete(`${process.env.tgcms}/archived-clients/${process.env.mobile}`);
    process.exit(1);
  }
  if (error.errorMessage === "USER_DEACTIVATED_BAN" || error.errorMessage === "USER_DEACTIVATED") {
    console.log(`${(process.env.clientId).toUpperCase()}-${clientId} USER_DEACTIVATED : Exitiing`)
    await fetchWithTimeout(`${ppplbot()}&text=@${(process.env.clientId).toUpperCase()}-${clientId}: USER_DEACTIVATED : Exitiing`);
    const db = UserDataDtoCrud.getInstance();
    const today = (new Date(Date.now())).toISOString().split('T')[0];
    const query = { availableDate: { $lte: today }, channels: { $gt: 200 } }
    const newPromoteClient = await db.findPromoteClient(query)
    if (newPromoteClient) {
      console.log(clientId, " - NEw Promote Client: ", newPromoteClient)
      await db.updateClient(
        {
          clientId: clientId
        },
        {
          promoteMobile: newPromoteClient.mobile
        }
      )
      await db.deletePromoteClient({ mobile: this.clientDetails.mobile })
    } else {
      console.log(`${(process.env.clientId).toUpperCase()}-${clientId} new client does not exist`)
    }
    // process.exit(1)
  }
}

export function getdaysLeft(inputDate) {
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];
  const dateParts = inputDate.split(' ');
  const day = parseInt(dateParts[0], 10);
  const monthIndex = months.indexOf(dateParts[1]);
  const year = parseInt(dateParts[2], 10);
  const parsedDate = new Date(year, monthIndex, day);
  const todaysDate = new Date();
  const parsedDateTimestamp = parsedDate.getTime();
  const todaysDateTimestamp = todaysDate.getTime();
  const timeDifference = parsedDateTimestamp - todaysDateTimestamp;
  const daysDifference = Math.ceil(timeDifference / (1000 * 60 * 60 * 24));
  return daysDifference;
}

export const openChannels = [
  "1503501267",
  "1551323319",
  "1874177023",
  "1726884257",
  "2078206164",
  "1783847947",
  "1280090273",
  "1680562555",
  "2034836144",
  "1837117287",
  "2048953473",
  "1659680108",
  "1942384583",
  "1633338877",
  "2062130327",
  "1801945887",
  "1825148754",
  "1586137943",
  "1847027610",
  "1508171809",
  "1712982876",
  "1249091516",
  "1514843822",
  "1959564784",
  "1529606821",
  "1751125886",
  "1755570724",
  "1627383361",
  "1687496208",
  "1541729758",
  "2003519665",
  "1913476459",
  "1548006801",
  "2035631610",
  "1236560723",
  "1622766959",
  "2049243534",
  "1780327268",
  "1803626686",
  "1802180690",
  "1769784193",
  "2087610212",
  "1813163445",
  "1684831952",
  "1387333195",
  "2122118869",
  "1887746719",
  "1652078022",
  "1988938452",
  "1583611497",
  "1673218199",
  "2122063964",
  "1956751085",
  "1686773455",
  "1705755336",
  "1894460536",
  "1635649108",
  "2064393771",
  "1831901563",
  "1862260678",
  "1318582599",
  "2106543232",
  "1654557420",
  "1181590789",
  "1222174863",
  "2008789348",
  "1746586826",
  "2121282957",
  "1794858656",
  "1617883662",
  "1590103744",
  "1972653135",
  "2041058457",
  "1546582368",
  "1673831190",
  "1637480510",
  "1480040054",
  "2115440057",
  "2059483606",
  "1336087349",
  "1347315367",
  "1935653698",
  "1209858289",
  "1650098849",
  "1643694723",
  "1732214668",
  "1740047200",
  "1586912179",
  "1559696504",
  "1469191373",
  "1851254214",
  "1234379666",
  "1917165275",
  "1584560094",
  "1179319575",
  "1641006506",
  "2035989217",
  "1926661300",
  "1678130613",
  "1727190974",
  "2093547249",
  "1652554715",
  "1772077397",
  "1929734618",
  "1394253915",
  "1519468408",
  "2141607443",
  "1314177183",
  "1624967628",
  "2091837588",
  "1614393352",
  "1720123123",
  "1709882922",
  "2104429073",
  "1922992673",
  "1376948626",
  "1814963734",
  "2186436757",
  "1813392684",
  "1875330360",
  "1746364549"
]

export function getRandomEmoji(): string {
  const eroticEmojis: string[] = ["🔥", "💋", "👅", "🍆", "🔥", "💋", " 🙈", "👅", "🍑", "🍆", "💦", "🍑", "😚", "😏", "💦", "🥕", "🥖"];
  const randomIndex = Math.floor(Math.random() * eroticEmojis.length);
  return eroticEmojis[randomIndex];
}

export function generateEmojis(): string {
  const emoji1 = getRandomEmoji();
  const emoji2 = getRandomEmoji();
  return emoji1 + emoji2;
}

export function getCurrentHourIST(): number {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffset);
  const istHour = istTime.getUTCHours();
  return istHour;
}
export interface PromoteClientPayload {
  tgId: string;
  mobile: string;
  availableDate: string;
  lastActive: string;
  channels: number;
}

export const createPromoteClient = async (payload: PromoteClientPayload): Promise<void> => {
  try {
    const response = await axios.post(`${process.env.uptimeChecker}/promoteclients`, payload, {
      headers: {
        'accept': '*/*',
        'Content-Type': 'application/json',
      },
    });
    console.log('Response:', response.data);
  } catch (error) {
    parseError(error, "Failedd to insert promoteClient");
  }
};
