FROM docker.elastic.co/elasticsearch/elasticsearch:8.15.0

# 与官方 ES 版本对齐的 IK 分词插件（索引 ik_max_word / 查询 ik_smart）
RUN elasticsearch-plugin install --batch \
  https://release.infinilabs.com/analysis-ik/stable/elasticsearch-analysis-ik-8.15.0.zip
