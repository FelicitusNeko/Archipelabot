import debug from "debug";
import { Sequelize, DataTypes, Model } from "sequelize";

const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: "./apbot.sqlite",
  logging: debug("sql"),
});

interface YamlAttributes {
  code: string;
  userId: string;
  filename: string;
  description: string;
  playerName: string[];
  games: string[];
}
class YamlTable extends Model<YamlAttributes, YamlAttributes> {
  public code!: string;
  public userId!: string;
  public filename!: string;
  public description!: string;
  public playerName!: string[];
  public games!: string[];

  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}
YamlTable.init(
  {
    code: {
      type: DataTypes.STRING(4),
      primaryKey: true,
      validate: {
        is: /^[A-Z]{4}$/,
      },
    },
    userId: {
      type: DataTypes.STRING(20),
      allowNull: false,
      validate: {
        isNumeric: true,
        len: [16, 20],
      },
    },
    filename: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    description: {
      type: DataTypes.STRING(255),
      allowNull: false,
      defaultValue: "No description provided",
    },
    playerName: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
    },
    games: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
    },
  },
  {
    sequelize,
    tableName: "yaml",
  }
);

interface PlayerAttributes {
  userId: string;
  defaultCode: string | null;
}
class PlayerTable extends Model<PlayerAttributes, PlayerAttributes> {
  public userId!: string;
  public defaultCode!: string | null;

  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}
PlayerTable.init(
  {
    userId: {
      type: DataTypes.STRING(20),
      primaryKey: true,
      validate: {
        isNumeric: true,
        len: [16, 20],
      },
    },
    defaultCode: {
      type: DataTypes.STRING(4),
      allowNull: true,
      defaultValue: null,
      validate: {
        is: /^[A-Z]{4}$/,
      },
    },
  },
  {
    sequelize,
    tableName: "players",
  }
);

interface SessionAttributes {
  code: string;
  guildId: string;
  userId: string;
  filename: string;
  status: number;
}
class SessionTable extends Model<SessionAttributes, SessionAttributes> {
  public code!: string;
  public guildId!: string;
  public userId!: string;
  public filename!: string;
  public status!: number;

  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}
SessionTable.init(
  {
    code: {
      type: DataTypes.STRING(4),
      primaryKey: true,
      validate: {
        is: /^[A-Z]{4}$/,
      },
    },
    guildId: {
      type: DataTypes.STRING(20),
      allowNull: false,
      validate: {
        isNumeric: true,
        len: [16, 20],
      },
    },
    userId: {
      type: DataTypes.STRING(20),
      allowNull: false,
      validate: {
        isNumeric: true,
        len: [16, 20],
      },
    },
    filename: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    status: {
      type: DataTypes.SMALLINT,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    sequelize,
    tableName: "games",
  }
);

sequelize.sync();

export default sequelize;
export { YamlTable, PlayerTable, SessionTable };
